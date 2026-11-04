import { expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hotp, totpStep } from '../src/lib/totp.js';

export const PASSWORD = 'correct horse battery staple';

let media = null;
/** Makes (once) a real test video with ffmpeg's test sources: a moving pattern and a tone. Returns file paths. */
export function sampleMedia({ seconds = 45 } = {}) {
  if (media) return media;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-e2e-media-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'Harbour at sunrise.mp4');
  const a = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video],
    { encoding: 'utf8' },
  );
  if (a.status !== 0) throw new Error(`ffmpeg could not make the sample video: ${a.stderr}`);
  const thumb = path.join(dir, 'cover.png');
  const b = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1:duration=1', '-frames:v', '1', thumb], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`ffmpeg could not make the sample cover: ${b.stderr}`);
  media = { video, thumb };
  return media;
}

/**
 * Collects what should never happen on a healthy page: console errors (this includes blocked-by-policy and failed
 * loads), uncaught exceptions, failed requests and server errors. `expected(/text/)` removes a known, deliberate one.
 */
export function watchProblems(context) {
  const problems = [];
  const record = (text) => problems.push(text);
  const hook = (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') record(`console error: ${m.text()} (${m.location().url})`);
    });
    page.on('pageerror', (e) => record(`uncaught exception: ${e.message}`));
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? '';
      if (!/ERR_ABORTED/.test(why)) record(`request failed: ${r.method()} ${r.url()} ${why}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 500) record(`server error ${r.status()}: ${r.request().method()} ${r.url()}`);
    });
  };
  context.pages().forEach(hook);
  context.on('page', hook);
  context.exposeFunction('__vvViolation', (text) => record(`CSP violation: ${text}`)).catch(() => {});
  context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      try {
        window.__vvViolation(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} on ${location.pathname}`);
      } catch {
        /* the page is going away */
      }
    });
  });
  return {
    problems,
    /** Removes problems that match, and returns how many were removed. */
    expected(pattern) {
      let n = 0;
      for (let i = problems.length - 1; i >= 0; i -= 1) {
        if (pattern.test(problems[i])) {
          problems.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
    clear() {
      problems.length = 0;
    },
  };
}

/** Polls the test server's outbox until a mail to `to` (matching `pattern`) has been "sent". */
export async function waitForMail(request, to, pattern) {
  let found = null;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/__e2e/outbox?to=${encodeURIComponent(to)}`);
        const mails = await res.json();
        found = [...mails].reverse().find((m) => pattern.test(m.text)) ?? null;
        return !!found;
      },
      { message: `waiting for an email to ${to}`, timeout: 15_000 },
    )
    .toBe(true);
  return found;
}

export async function signUp(page, { name, handle, email }) {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Handle').fill(handle);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('I am 18 years old or older.').check();
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
}

export async function confirmEmail(page, email) {
  const mail = await waitForMail(page.request, email, /verify-email\?token=/);
  const link = /https?:\/\/\S+\/verify-email\?token=[\w-]+/.exec(mail.text)[0];
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm email address' }).click();
  await expect(page.getByText('Email address confirmed.')).toBeVisible();
}

export async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('details.menu > summary')).toBeVisible();
}

export async function newMember(page, who) {
  await signUp(page, who);
  await confirmEmail(page, who.email);
  await signIn(page, who.email);
}

/** From a signed-in page: accept the creator terms if asked, upload the sample video, wait until it is ready. Returns its id. */
export async function uploadSampleVideo(page, { title, description = '', tags = '' }) {
  await page.goto('/studio/upload');
  if (page.url().includes('/studio/terms') || (await page.getByRole('heading', { name: 'Before you upload' }).count())) {
    await page.getByLabel(/I have read the creator terms/).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Upload a video' })).toBeVisible();
  await page.locator('#file').setInputFiles(sampleMedia().video);
  await expect(page.locator('#file-name')).toContainText('Harbour at sunrise.mp4');
  await expect(page.getByLabel('Title')).toHaveValue('Harbour at sunrise'); // filled in from the file name
  await page.getByLabel('Title').fill(title);
  if (description) await page.getByLabel('Description').fill(description);
  if (tags) await page.getByLabel('Tags').fill(tags);
  await page.getByRole('button', { name: 'Upload' }).click();
  const edit = page.getByRole('link', { name: 'Review details and thumbnail' });
  await expect(edit).toBeVisible({ timeout: 120_000 });
  const href = await edit.getAttribute('href');
  return href.split('/').pop();
}

/** True when this browser can play H.264 in an HLS stream through Media Source Extensions. */
export const canPlayH264 = (page) =>
  page.evaluate(() => !!window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"'));

/** Waits for the player to have a frame ready, plays it with the keyboard shortcut, and returns once it has advanced `seconds`. */
export async function playFor(page, seconds) {
  await page.waitForFunction(() => {
    const v = document.getElementById('player');
    return v && v.readyState >= 2;
  });
  const before = await page.evaluate(() => document.getElementById('player').currentTime);
  await page.locator('#player').click({ position: { x: 20, y: 20 } }).catch(() => {});
  const paused = await page.evaluate(() => document.getElementById('player').paused);
  if (paused) await page.keyboard.press('k');
  await page.waitForFunction(([from, s]) => document.getElementById('player').currentTime >= from + s, [before, seconds], { timeout: (seconds + 30) * 1000 });
}

export async function signOut(page) {
  await page.goto('/');
  await page.locator('details.menu > summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You are signed out.')).toBeVisible();
}

/** From a signed-in page: turns on two-step verification through the settings screens. Returns the key and the recovery codes. */
export async function enrollTotp(page) {
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  const key = (await page.locator('code.secret').textContent()).replace(/\s+/g, '');
  await page.getByLabel('Code from the app').fill(hotp(key, totpStep(Date.now())));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification is on' })).toBeVisible();
  const codes = await page.locator('ul.codes li code').allTextContents();
  await page.getByRole('link', { name: 'I have saved them' }).click();
  return { key, codes };
}

/** The code an authenticator app shows one step later than the one just used (a code works only once). */
export const nextCode = (key) => hotp(key, totpStep(Date.now()) + 1);

/** Starts a sign-in with the password and stops at the code screen. */
export async function signInUntilCode(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
}
