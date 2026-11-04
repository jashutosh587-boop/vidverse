import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { hotp, totpStep } from '../src/lib/totp.js';
import { sampleMedia, watchProblems, signUp, confirmEmail, signIn, newMember, uploadSampleVideo, canPlayH264, playFor, signOut, enrollTotp, nextCode, signInUntilCode, PASSWORD } from './helpers.js';

/**
 * One story, told in a real browser, in order: a stranger arrives, a creator joins and uploads, a viewer joins and
 * watches, likes, subscribes, comments, searches, tips, and asks the help assistant. Later tests in this file
 * attack the site from a browser's point of view and run an accessibility scan over every kind of page.
 */
test.describe.configure({ mode: 'serial' });

const creator = { name: 'Asha Rao', handle: 'asha.films', email: 'asha@example.com' };
const viewer = { name: 'Vik Menon', handle: 'vik_m', email: 'vik@example.com' };
const admin = { name: 'Meena Admin', handle: 'meena.admin', email: 'meena@example.com' };
const hostile = { name: '<img src=x onerror="window.__pwned=3"> Zed', handle: 'zed.hostile', email: 'zed@example.com' };
const WHO = ['stranger', 'creator', 'viewer', 'admin', 'anon'];
const ATTACKER = 'http://127.0.0.1:4174'; // the second test server, standing in for another website
const TITLE = 'Harbour at sunrise: a quiet morning';

/** state shared by the tests below */
const s = {};

test.beforeAll(async ({ browser }, testInfo) => {
  const { baseURL, viewport } = testInfo.project.use;
  s.base = baseURL;
  for (const who of WHO) {
    const context = await browser.newContext({ baseURL, viewport });
    const watcher = watchProblems(context);
    s[who] = { context, watcher, page: await context.newPage() };
  }
  sampleMedia(); // make the test video once, up front
});

test.afterAll(async () => {
  for (const who of WHO) await s[who]?.context.close();
});

test.afterEach(async ({}, testInfo) => {
  const all = WHO.flatMap((who) => s[who].watcher.problems.map((p) => `[${who}] ${p}`));
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const who of WHO) {
      await s[who].page.screenshot({ path: testInfo.outputPath(`${who}.png`), fullPage: true }).catch(() => {});
    }
  }
  for (const who of WHO) s[who].watcher.clear();
  expect(all, 'the browser reported problems').toEqual([]);
});

// ------------------------------------------------------------------------------------------------ arriving

test('a stranger sees an empty but working front page, and a theme switch that sticks', async () => {
  const { page } = s.stranger;
  await page.goto('/');
  await expect(page).toHaveTitle(/Vidverse/);
  await expect(page.getByRole('heading', { name: 'No videos yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();

  await page.getByRole('button', { name: 'Switch between light and dark' }).click();
  const theme = await page.locator('html').getAttribute('data-theme');
  expect(['light', 'dark']).toContain(theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
});

test('the studio is closed to strangers, and the sign-up form explains mistakes', async () => {
  const { page } = s.stranger;
  await page.goto('/studio');
  await expect(page).toHaveURL(/\/login\?next=%2Fstudio/);

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Test Person');
  await page.getByLabel('Handle').fill('test.person');
  await page.getByLabel('Email address').fill('test.person@example.com');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#f-password-err')).toContainText(/at least 10/i);
  await expect(page.getByLabel('Your name')).toHaveValue('Test Person'); // what they typed is kept
  await expect(page.locator('#f-adult-err')).toBeVisible(); // the unticked boxes are named too
  await expect(password).toHaveValue(''); // but a password is never sent back to the page
  expect(s.stranger.watcher.expected(/status of 422.*\/signup/)).toBe(1); // the form's own "422" answer is deliberate
});

test('a creator signs up, confirms the email address and signs in', async () => {
  const { page } = s.creator;
  await signUp(page, creator);
  await confirmEmail(page, creator.email);
  await signIn(page, creator.email);
  await expect(page.getByRole('link', { name: 'Upload' }).first()).toBeVisible();
});

// ------------------------------------------------------------------------------------------------ uploading

test('the creator uploads a video, waits for it to be processed, and sets a cover image', async () => {
  const { page } = s.creator;
  s.videoId = await uploadSampleVideo(page, {
    title: TITLE,
    description: 'A calm morning at the harbour.\n\nChapters:\n0:10 Water\n0:20 Boats',
    tags: 'harbour, sunrise, travel',
  });
  expect(s.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/);

  await page.getByRole('link', { name: 'Review details and thumbnail' }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/videos/${s.videoId}`));
  await expect(page.getByLabel('Title')).toHaveValue(TITLE);
  const before = await page.request.get(`/media/t/${s.videoId}.jpg`);
  expect(before.status()).toBe(200);
  expect(before.headers()['content-type']).toMatch(/image\/jpeg/);

  await page.locator('#thumb-file').setInputFiles(sampleMedia().thumb);
  await expect(page).toHaveURL(/saved=1/);
  const after = await page.request.get(`/media/t/${s.videoId}.jpg`);
  expect(after.status()).toBe(200);

  await page.goto('/studio/videos');
  const row = page.getByRole('row', { name: new RegExp(TITLE) });
  await expect(row).toContainText('Ready');
  await expect(row).toContainText('Public');
});

// ------------------------------------------------------------------------------------------------ watching

test('a viewer signs up and finds the new video on the front page', async () => {
  const { page } = s.viewer;
  await newMember(page, viewer);
  await page.goto('/');
  const title = page.getByRole('link', { name: TITLE });
  await expect(title).toBeVisible();
  await expect(page.locator('.vcard').first()).toContainText('Asha Rao');
  await title.click();
  await expect(page).toHaveURL(new RegExp(`/watch/${s.videoId}$`));
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
});

test('the video really plays: adaptive stream, quality list, speed, keyboard keys', async () => {
  const { page } = s.viewer;
  await page.goto(`/watch/${s.videoId}`);
  test.skip(!(await canPlayH264(page)), 'this browser build cannot decode H.264, so playback cannot be proven here');

  await playFor(page, 4);
  const state = await page.evaluate(() => {
    const v = document.getElementById('player');
    return { time: v.currentTime, paused: v.paused, width: v.videoWidth, height: v.videoHeight, duration: v.duration, error: v.error?.message ?? null };
  });
  expect(state.error).toBeNull();
  expect(state.paused).toBe(false);
  expect(state.width).toBeGreaterThan(0);
  expect(state.duration).toBeGreaterThan(40);
  await expect(page.locator('.player-problem')).toHaveCount(0);

  // The quality list is filled from the stream: Auto plus real rungs.
  await expect.poll(() => page.locator('#quality option').count()).toBeGreaterThan(1);
  await expect(page.locator('#quality')).toBeEnabled();
  const labels = await page.locator('#quality option').allTextContents();
  expect(labels.join(' ')).toMatch(/720p/);
  expect(labels.join(' ')).toMatch(/360p/);

  // Choosing a quality switches the picture that is really decoded; Auto goes back to the player's choice.
  await page.locator('#quality').selectOption({ label: '360p' });
  await page.waitForFunction(() => document.getElementById('player').videoHeight === 360, null, { timeout: 30_000 });
  await page.locator('#quality').selectOption('-1');

  // Speed is applied to the video and remembered.
  await page.locator('#speed').selectOption('1.5');
  expect(await page.evaluate(() => document.getElementById('player').playbackRate)).toBe(1.5);
  expect(await page.evaluate(() => localStorage.getItem('vv-speed'))).toBe('1.5');
  await page.locator('#speed').selectOption('1');

  // Keyboard keys: l skips ahead, j back, m mutes, k pauses.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const t0 = await page.evaluate(() => document.getElementById('player').currentTime);
  await page.keyboard.press('l');
  const t1 = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(t1 - t0).toBeGreaterThan(8);
  await page.keyboard.press('j');
  const t2 = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(t1 - t2).toBeGreaterThan(8);
  await page.keyboard.press('m');
  expect(await page.evaluate(() => document.getElementById('player').muted)).toBe(true);
  await page.keyboard.press('m');

  const beat = page.waitForResponse((r) => r.url().includes('/heartbeat') && r.request().method() === 'POST');
  await page.keyboard.press('k');
  expect(await page.evaluate(() => document.getElementById('player').paused)).toBe(true);
  expect((await beat).status()).toBe(204); // pausing reports the time actually watched
});

test('watching long enough counts as a view; a few seconds does not', async () => {
  const { page } = s.viewer;
  test.skip(!(await canPlayH264(page)), 'no H.264 in this browser build');
  await page.goto(`/watch/${s.videoId}`);
  // The earlier test watched about five seconds. A view needs 30 seconds of real watching, so that did not count.
  await expect(page.locator('.descbox')).toContainText('0 views');

  // Double speed keeps this test short: 30 seconds of video in about 15 of real time. The server credits what the
  // clock allows, so this is still real watching, not a number the page can inflate.
  await page.locator('#speed').selectOption('2');
  await playFor(page, 30);
  const beat = page.waitForResponse((r) => r.url().includes('/heartbeat') && r.request().method() === 'POST');
  await page.keyboard.press('k');
  expect((await beat).status()).toBe(204);
  await page.locator('#speed').selectOption('1');

  await page.reload();
  await expect(page.locator('.descbox')).toContainText('1 view');
  await expect(page.locator('.descbox')).not.toContainText('1 views');
});

test('the video resumes where the viewer stopped, and shows under "Continue watching"', async () => {
  const { page } = s.viewer;
  test.skip(!(await canPlayH264(page)), 'no H.264 in this browser build');
  await page.goto(`/watch/${s.videoId}`);
  await page.waitForFunction(() => document.getElementById('player').readyState >= 2);
  await page.evaluate(() => {
    document.getElementById('player').currentTime = 20; // what dragging the progress bar does
  });
  await playFor(page, 1.5);
  const beat = page.waitForResponse((r) => r.url().includes('/heartbeat') && r.request().method() === 'POST');
  await page.keyboard.press('k');
  await beat;
  const stoppedAt = await page.evaluate(() => document.getElementById('player').currentTime);
  expect(stoppedAt).toBeGreaterThan(20);

  await page.reload();
  const resume = Number(await page.locator('#player').getAttribute('data-resume'));
  expect(resume).toBeGreaterThan(19);
  expect(resume).toBeLessThan(25);
  await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime), { timeout: 20_000 }).toBeGreaterThan(resume - 2);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Continue watching' })).toBeVisible();
  await expect(page.locator('.strip .vcard progress')).toHaveCount(1);
});

test('like, subscribe, watch later and comment, without leaving the page', async () => {
  const { page } = s.viewer;
  await page.goto(`/watch/${s.videoId}`);

  const like = page.getByRole('button', { name: /^Like \d+$/ });
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-likes]').first()).toHaveText('1');

  await expect(page.getByRole('button', { name: 'Subscribe', exact: true })).toHaveAttribute('aria-pressed', 'false'); // printed as a real false, not empty
  await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Subscribed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-subscribers]')).toContainText('1 subscriber');
  await expect(page.getByRole('button', { name: 'Notify me about new videos' })).toBeVisible();

  await page.getByRole('button', { name: /Watch later/ }).click();
  await expect(page.getByRole('button', { name: /Saved/ })).toBeVisible();
  await expect(page.locator('.toast')).toContainText(/Saved to Watch later/);

  // All of that is stored on the server, not just shown.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Like \d+$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Subscribed' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Saved/ })).toBeVisible();

  await page.getByLabel('Add a comment').fill('Lovely light in this one!');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.commentlist')).toContainText('Lovely light in this one!');
  await expect(page.getByRole('heading', { name: '1 comment' })).toBeVisible();

  // Hostile text is shown as text and never runs.
  await page.getByLabel('Add a comment').fill('<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"> **bold?**');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.commentlist')).toContainText('<script>window.__pwned=1</script>');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('.commentlist img')).toHaveCount(0);
});

test('search suggests while typing, finds the video, and says so plainly when nothing matches', async () => {
  const { page } = s.viewer;
  await page.goto('/');
  const box = page.getByRole('combobox', { name: 'Search videos and channels' });
  await box.fill('harb');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toContainText(/harbour/i);
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  await box.fill('sunrise harbour');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/results\?q=sunrise/);
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();

  await box.fill('zzzzzqqqq');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'No results' })).toBeVisible();
});

test('the channel page and the subscriptions feed show the creator’s work', async () => {
  const { page } = s.viewer;
  await page.goto(`/@${creator.handle}`);
  await expect(page.getByRole('heading', { level: 1, name: creator.name })).toBeVisible();
  await expect(page.getByRole('link', { name: TITLE }).first()).toBeVisible();
  await page.goto('/subscriptions');
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
  await page.goto('/liked');
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
  await page.goto('/watch-later');
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
  await page.goto('/history');
  await expect(page.getByRole('link', { name: TITLE })).toBeVisible();
});

// ------------------------------------------------------------------------------------------------ money

test('the viewer tips the creator in practice mode, and the creator sees the money held', async () => {
  const { page } = s.viewer;
  await page.goto(`/watch/${s.videoId}`);
  await page.getByRole('link', { name: 'Support' }).click();
  await expect(page.getByRole('heading', { name: `Support ${creator.name}` })).toBeVisible();
  await expect(page.getByText('Practice mode.').first()).toBeVisible();

  await page.getByRole('button', { name: 'Continue to payment' }).click(); // nothing chosen yet
  await expect(page.locator('#f-amount-err')).toBeVisible();
  expect(s.viewer.watcher.expected(/status of 422.*\/support\//)).toBe(1); // deliberate
  await page.getByLabel('₹100').check();
  await page.getByLabel('A message for the creator (optional)').fill('Thank you for the calm');
  await page.getByRole('button', { name: 'Continue to payment' }).click();

  // Our policy lets forms go only to this site, so the hop to the payment page is a link the viewer clicks.
  await expect(page.getByRole('heading', { name: 'Continue to payment' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(/\/support\/test-checkout\//);
  await expect(page.getByRole('heading', { name: 'Practice checkout' })).toBeVisible();
  await page.getByRole('button', { name: /Pretend to pay/ }).click();
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(page.getByText(/tip of ₹100\.00/)).toBeVisible();

  const { page: studio } = s.creator;
  await studio.goto('/studio/earnings');
  await expect(studio.locator('.stats')).toContainText('₹90.00'); // ₹100 less the 10% fee
  await expect(studio.getByText('Pending, still in the 7-day holding period')).toBeVisible();
  await expect(studio.locator('body')).toContainText('Thank you for the calm');

  // The statement downloads as a file, the way a person would get it.
  const [download] = await Promise.all([studio.waitForEvent('download'), studio.getByRole('link', { name: 'Download statement (CSV)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^vidverse-statement-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await download.path(), 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff); // a byte-order mark, so Excel reads the rupee sign and Indian names correctly
  expect(text).toContain('90.00');
  expect(text).toContain('tip_net');
});

// ------------------------------------------------------------------------------------------------ help

test('the help assistant answers from the help articles, admits what it cannot answer, and traps no keyboard', async () => {
  const { page } = s.viewer;
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Help', exact: true });
  await toggle.click();
  const panel = page.getByRole('dialog', { name: 'Help assistant' });
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Your question')).toBeFocused();

  await page.getByLabel('Your question').fill('How do I upload a video?');
  await page.getByRole('button', { name: 'Ask' }).click();
  const answer = panel.locator('.assistant-bot').last();
  await expect(answer).toContainText(/upload/i, { timeout: 10_000 });
  await expect(answer.getByRole('link').first()).toHaveAttribute('href', /^\/help\//);

  await page.getByLabel('Your question').fill('What is the weather in Pune tomorrow?');
  await page.getByRole('button', { name: 'Ask' }).click();
  const refusal = panel.locator('.assistant-bot').last();
  await expect(refusal).not.toContainText('Looking through');
  await expect(refusal.getByRole('link', { name: 'Contact support' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();

  // The help centre itself: search, an article, and the legal pages the sign-up form promised.
  await page.goto('/help');
  await page.getByLabel('Search the help center').fill('how do payouts work');
  await page.locator('.helpsearch').getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/help\?q=/);
  await expect(page.getByRole('heading', { name: 'Best matches' })).toBeVisible();
  await expect(page.locator('.helpresults a').first()).toContainText(/payout/i);
  await page.getByLabel('Search the help center').fill('qzxwv blorptang');
  await page.locator('.helpsearch').getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing in the help center matches that' })).toBeVisible();
  await page.goto('/legal/terms');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Terms/);
  await page.goto('/legal/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Privacy/);
});

test('signing out ends the session', async () => {
  const { page } = s.viewer;
  await page.goto('/');
  await page.locator('details.menu > summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You are signed out.')).toBeVisible();
  await page.goto('/studio');
  await expect(page).toHaveURL(/\/login/);
  // signing back in works with the same details
  await signIn(page, viewer.email);
});

// ------------------------------------------------------------------------------------------------ two-step verification

test('two-step verification: wrong codes are refused; the right code and each recovery code work once', async () => {
  const { page, watcher } = s.creator;
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const key = (await page.locator('code.secret').textContent()).replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);

  await page.getByLabel('Code from the app').fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('alert')).toContainText(/did not work/);
  expect(watcher.expected(/status of 422.*2fa\/confirm/)).toBe(1);

  await page.getByLabel('Code from the app').fill(hotp(key, totpStep(Date.now())));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification is on' })).toBeVisible();
  const codes = await page.locator('ul.codes li code').allTextContents();
  expect(codes.length).toBeGreaterThanOrEqual(6);
  expect(new Set(codes).size).toBe(codes.length);
  await page.getByRole('link', { name: 'I have saved them' }).click();
  await expect(page.locator('.pill-ok')).toHaveText('On');

  // From now on a password is not enough.
  await signOut(page);
  await signInUntilCode(page, creator.email);
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText(/not right/);
  expect(watcher.expected(/status of 401.*login\/mfa/)).toBe(1);
  await page.getByLabel('Code').fill(nextCode(key));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('details.menu > summary')).toBeVisible();

  // A recovery code gets someone in once. The second time it is refused.
  await signOut(page);
  await signInUntilCode(page, creator.email);
  await page.getByLabel('Code').fill(codes[0]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('details.menu > summary')).toBeVisible();

  await signOut(page);
  await signInUntilCode(page, creator.email);
  await page.getByLabel('Code').fill(codes[0]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText(/not right|already used/);
  expect(watcher.expected(/status of 401.*login\/mfa/)).toBe(1);
  await page.getByLabel('Code').fill(codes[1]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('details.menu > summary')).toBeVisible();

  // Turning it off asks for the password again.
  await page.goto('/settings/security');
  await page.getByLabel('Password, to turn it off').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn off two-step verification' }).click();
  await expect(page.getByText('Two-step verification is off.')).toBeVisible();
});

// ------------------------------------------------------------------------------------------------ attacks, seen from the browser

test('hostile names and search text are shown as text everywhere and never run', async () => {
  const { page } = s.stranger;
  await newMember(page, hostile);
  const pages = ['/', `/watch/${s.videoId}`, '/settings/profile', `/@${hostile.handle}`, `/@${creator.handle}`, '/results?q=%3Cimg+src%3Dx+onerror%3Dwindow.__pwned%3D5%3E', '/help?q=%3Csvg+onload%3Dwindow.__pwned%3D6%3E'];
  for (const url of pages) {
    await page.goto(url);
    expect(await page.evaluate(() => window.__pwned), url).toBeUndefined();
    expect(await page.locator('img[src="x"], svg[onload]').count(), url).toBe(0);
  }
  // On the pages that show the name, it appears as the characters typed.
  await page.goto('/settings/profile');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(hostile.name);
  await page.goto('/results?q=%3Cimg+src%3Dx+onerror%3Dwindow.__pwned%3D5%3E');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('<img src=x onerror=window.__pwned=5>');

  // The hostile member comments, and the creator sees the name as plain text in the comment and in the notification.
  await page.goto(`/watch/${s.videoId}`);
  await page.getByLabel('Add a comment').fill('Nice one, from the hostile name.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.commentlist')).toContainText('Nice one, from the hostile name.');
  await expect(page.locator('.commentlist')).toContainText(hostile.name);

  const { page: studio } = s.creator;
  await studio.goto('/notifications');
  await expect(studio.locator('body')).toContainText(hostile.name);
  expect(await studio.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await studio.locator('img[src="x"]').count()).toBe(0);
  await studio.goto(`/watch/${s.videoId}`);
  expect(await studio.locator('img[src="x"]').count()).toBe(0);
});

test('the page policy and cookies hold up in a real browser: no injected code runs, and the cookie cannot be read by scripts', async () => {
  const { page, context, watcher } = s.viewer;
  const cookies = await context.cookies();
  const sid = cookies.find((c) => c.name === '__Host-vv_sid');
  expect(sid, 'the session cookie').toBeTruthy();
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  for (const c of cookies.filter((x) => x.name.startsWith('__Host-'))) expect(c.secure, c.name).toBe(true);

  const first = await page.goto('/');
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/vv_sid/);
  const h = first.headers();
  const csp = h['content-security-policy'];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['cache-control']).toMatch(/no-store/);
  expect(h['x-powered-by']).toBeUndefined();
  const second = await page.reload();
  const nonce = (r) => /nonce-([^']+)'/.exec(r.headers()['content-security-policy'])[1];
  expect(nonce(second)).not.toBe(nonce(first));

  // What an attacker who got markup onto the page would try. The browser must refuse each one.
  const result = await page.evaluate(async () => {
    const out = {};
    const img = document.createElement('img');
    img.setAttribute('onerror', 'window.__inj = 1');
    img.src = '/no-such-picture.png';
    document.body.appendChild(img);
    document.body.insertAdjacentHTML('beforeend', '<a id="evil" href="javascript:window.__inj=2">x</a>');
    document.getElementById('evil').click();
    await new Promise((r) => setTimeout(r, 400));
    out.handler = window.__inj === undefined ? 'blocked' : 'RAN';
    try {
      out.eval = String(eval('1 + 1'));
    } catch (e) {
      out.eval = `blocked: ${e.name}`;
    }
    const frame = document.createElement('iframe');
    frame.src = 'https://example.com/';
    document.body.appendChild(frame);
    await new Promise((r) => setTimeout(r, 300));
    return out;
  });
  expect(result.handler).toBe('blocked');
  expect(result.eval).toMatch(/^blocked/);
  // The browser reported those as policy violations, which is the proof that it was the policy that stopped them.
  expect(watcher.expected(/CSP violation: script-src-attr/)).toBeGreaterThan(0);
  expect(watcher.expected(/CSP violation: frame-src|CSP violation: default-src/)).toBeGreaterThan(0);
  watcher.expected(/no-such-picture|Refused to|Content Security Policy|CSP violation/);
});

test('another website cannot act for a signed-in member, and cannot put the site in a frame', async () => {
  const { page, context, watcher } = s.viewer;
  const target = s.base;
  await context.route('http://evil.test/**', (route) => {
    const url = new URL(route.request().url());
    const body =
      url.pathname === '/csrf'
        ? `<form id="f" method="post" action="${target}/logout"></form><script>document.getElementById('f').submit()</script>`
        : `<form id="f" method="post" action="${target}/videos/${s.videoId}/comments"><input name="body" value="posted by another site"></form><script>document.getElementById('f').submit()</script>`;
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });

  // 1. A form on another site that tries to sign the member out, and one that tries to post a comment as them.
  for (const [path, label] of [['/csrf', 'sign out'], ['/post-comment', 'post a comment']]) {
    const answered = page.waitForResponse((r) => r.url().startsWith(target) && r.request().method() === 'POST');
    await page.goto(`http://evil.test${path}`);
    expect((await answered).status(), `a forged request to ${label}`).toBe(403);
  }
  watcher.expected(/status of 403/);
  await page.goto(`/watch/${s.videoId}`);
  await expect(page.locator('details.menu > summary')).toBeVisible(); // still signed in
  await expect(page.locator('.commentlist')).not.toContainText('posted by another site');

  // 2. The site refuses to be shown inside another site's frame. The framing page comes from the second test server (another
  //    origin, equally local, so Chrome's protection for local networks does not get in the way first).
  await page.goto(`${ATTACKER}/__e2e/attacker/frame?target=${encodeURIComponent(`${target}/`)}`);
  await expect.poll(() => page.frames().length).toBeGreaterThan(1);
  await expect.poll(() => watcher.problems.some((p) => /Refused to display|X-Frame-Options|frame-ancestors/.test(p)), { timeout: 10_000 }).toBe(true);
  const inner = page.frames().find((f) => f !== page.mainFrame());
  expect(await inner.locator('header.topbar').count()).toBe(0); // none of the site's page is in the frame
  expect(watcher.expected(/Refused to display|X-Frame-Options|frame-ancestors/)).toBeGreaterThan(0);
  watcher.expected(/Failed to load resource|ERR_BLOCKED/); // the refused frame is also reported as a failed load
  await context.unroute('http://evil.test/**');
});

// ------------------------------------------------------------------------------------------------ keyboard

test('keyboard use: the skip link, visible focus, and menus that close with Escape', async () => {
  const { page } = s.anon;
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // Every control shows where the focus is.
  for (const target of [page.getByRole('link', { name: 'Sign in' }), page.getByRole('button', { name: 'Switch between light and dark' }), page.getByRole('combobox', { name: 'Search videos and channels' })]) {
    await target.focus();
    const visible = await target.evaluate((el) => {
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
      const ring = cs.boxShadow !== 'none';
      return outline || ring;
    });
    expect(visible, await target.evaluate((el) => el.outerHTML.slice(0, 80))).toBe(true);
  }

  // The left menu opens and closes from the keyboard.
  const menu = page.getByRole('button', { name: 'Show or hide the menu' });
  const before = await menu.getAttribute('aria-expanded');
  await menu.focus();
  await page.keyboard.press('Enter');
  expect(await menu.getAttribute('aria-expanded')).not.toBe(before);
  await page.keyboard.press('Enter');
  expect(await menu.getAttribute('aria-expanded')).toBe(before);

  // The share box is a disclosure that Escape closes and gives the focus back.
  await page.goto(`/watch/${s.videoId}`);
  const share = page.locator('details.share > summary');
  await share.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details.share')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('details.share')).not.toHaveAttribute('open', '');
  await expect(share).toBeFocused();
});

// ------------------------------------------------------------------------------------------------ staff

test('staff: an admin opens every admin page, and the pages that can move money wait for two-step verification', async () => {
  const { page, watcher } = s.admin;
  await newMember(page, admin);
  const promoted = await page.request.post(`/__e2e/promote?email=${encodeURIComponent(admin.email)}&role=admin`);
  expect(promoted.ok()).toBe(true);

  for (const url of ['/admin', '/admin/reports', '/admin/users', '/admin/videos', '/admin/messages', '/admin/jobs', '/admin/audit']) {
    const r = await page.goto(url);
    expect(r.status(), url).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  const blocked = await page.goto('/admin/payouts');
  expect(blocked.status()).toBe(403);
  await expect(page.locator('body')).toContainText(/two-step verification/i);
  watcher.expected(/status of 403/);

  s.adminTotp = await enrollTotp(page);
  for (const url of ['/admin/payouts', '/admin/payments', '/admin/revenue']) {
    const r = await page.goto(url);
    expect(r.status(), url).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await page.goto('/admin/payments');
  await expect(page.locator('body')).toContainText('₹100.00'); // the practice tip, seen from the staff side
});

test('everyday members cannot open the admin pages', async () => {
  const { page, watcher } = s.viewer;
  for (const url of ['/admin', '/admin/users', '/admin/payouts']) {
    const r = await page.goto(url);
    expect([403, 404], url).toContain(r.status());
  }
  watcher.expected(/status of (403|404)/);
});

// ------------------------------------------------------------------------------------------------ accessibility

const ACTORS = {
  anon: () => [
    '/', '/trending', '/results?q=harbour', '/results?q=zzzzqqq', `/watch/${s.videoId}`, `/@${creator.handle}`, '/help', '/help/uploading-videos', '/help/tips',
    '/legal/terms', '/legal/privacy', '/legal/community-guidelines', '/legal/creator-terms', '/contact', '/login', '/signup', '/forgot-password', '/no-such-page',
  ],
  viewer: () => [
    '/', `/watch/${s.videoId}`, '/subscriptions', '/history', '/watch-later', '/liked', '/notifications', '/settings/profile', '/settings/security', '/settings/preferences',
    '/settings/privacy', `/support/@${creator.handle}`, `/report?type=video&id=${s.videoId}`,
  ],
  creator: () => ['/studio', '/studio/videos', '/studio/upload', `/studio/videos/${s.videoId}`, '/studio/earnings', '/studio/payouts', '/notifications', `/watch/${s.videoId}`],
  admin: () => ['/admin', '/admin/reports', '/admin/users', '/admin/videos', '/admin/messages', '/admin/jobs', '/admin/audit', '/admin/payouts', '/admin/payments', '/admin/revenue'],
};
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

for (const scheme of ['light', 'dark']) {
  test(`accessibility scan (${scheme} theme): no axe violations on any kind of page, for strangers, members, creators and staff`, async () => {
    test.setTimeout(300_000);
    const found = [];
    let scanned = 0;
    for (const [actor, list] of Object.entries(ACTORS)) {
      const { page, watcher } = s[actor];
      await page.emulateMedia({ colorScheme: scheme });
      for (const url of list()) {
        const response = await page.goto(url);
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), scheme);
        // Scan the page itself, not an error page standing in for it.
        if (url === '/no-such-page') expect(response.status()).toBe(404);
        else expect(response.status(), `${actor} ${url}`).toBeLessThan(400);
        const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        scanned += 1;
        for (const v of axe.violations) {
          found.push(`${actor} ${url} [${scheme}] ${v.impact} ${v.id}: ${v.help}\n      ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n').slice(1, 3).join(' ').trim()).join('\n      ')}`);
        }
        if (process.env.E2E_SHOTS && actor !== 'admin') {
          const name = `${actor}${url.replace(/[^a-z0-9]+/gi, '-')}-${scheme}`.slice(0, 80);
          await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true });
        }
      }
      watcher.expected(/status of 404/);
      await page.emulateMedia({ colorScheme: null });
    }
    expect(scanned).toBeGreaterThan(40);
    expect(found.join('\n'), `${found.length} accessibility problems`).toBe('');
  });
}

// ------------------------------------------------------------------------------------------------ healthy watching
// Last on purpose: it adds a second public video, which would change what the earlier tests count and scan.

const TITLE2 = 'Harbour at dusk: the same boats, later';

test('autoplay follows "Up next", stops to ask "Still watching?" after three in a row, and stays quiet when switched off', async () => {
  test.setTimeout(420_000);
  const { page } = s.viewer;
  await page.goto('/');
  test.skip(!(await canPlayH264(page)), 'this browser build cannot decode H.264, so a video cannot be played to its end here');

  // A second video, so that there is always something to play next.
  s.secondId = await uploadSampleVideo(s.creator.page, { title: TITLE2, tags: 'harbour, travel' });

  const here = () => new URL(page.url()).pathname;
  const upNext = page.locator('[data-upnext]');
  const still = page.getByRole('alertdialog', { name: 'Still watching?' });
  const chain = () => page.evaluate(() => window.sessionStorage.getItem('vv-autoplay-chain'));
  /** Jumps to the last second and lets the player run off the end, as a person who watched it all would. */
  const playToTheEnd = async () => {
    await page.waitForFunction(() => {
      const v = document.getElementById('player');
      return v && v.readyState >= 2 && Number.isFinite(v.duration);
    });
    await page.evaluate(() => {
      const v = document.getElementById('player');
      v.currentTime = Math.max(0, v.duration - 1.5);
      return v.play();
    });
  };

  // 1. The first video ends. "Up next" names the next video, counts down from 5, then moves on by itself.
  await page.goto(`/watch/${s.videoId}`);
  await expect(page.locator('#autoplay-toggle')).toBeChecked();
  await playToTheEnd();
  await expect(upNext).toBeVisible({ timeout: 30_000 });
  await expect(upNext).toContainText(TITLE2);
  await expect(upNext.getByRole('button', { name: 'Play now' })).toBeFocused();
  await page.waitForURL(`**/watch/${s.secondId}`, { timeout: 20_000 });
  expect(await chain()).toBe('1');

  // 2. "Play now" skips the wait. Two more videos in a row make three.
  for (const [path, count] of [[s.videoId, '2'], [s.secondId, '3']]) {
    await playToTheEnd();
    await expect(upNext).toBeVisible({ timeout: 30_000 });
    await upNext.getByRole('button', { name: 'Play now' }).click();
    await page.waitForURL(`**/watch/${path}`, { timeout: 20_000 });
    expect(await chain()).toBe(count);
  }

  // 3. After the third in a row it stops and asks, and it does not move on by itself.
  await playToTheEnd();
  await expect(still).toBeVisible({ timeout: 30_000 });
  await expect(still.getByRole('button', { name: 'Keep watching' })).toBeFocused();
  await expect(upNext).toBeHidden();
  await page.waitForTimeout(6500); // longer than the 5 seconds a countdown would have taken
  expect(here()).toBe(`/watch/${s.secondId}`);
  await expect(upNext).toBeHidden();

  // 4. "Keep watching" starts the count again from nothing, and Cancel stops that countdown for good.
  await still.getByRole('button', { name: 'Keep watching' }).click();
  await expect(still).toBeHidden();
  await expect(upNext).toBeVisible();
  expect(await chain()).toBe('0');
  await upNext.getByRole('button', { name: 'Cancel' }).click();
  await expect(upNext).toBeHidden();
  await page.waitForTimeout(6500);
  expect(here()).toBe(`/watch/${s.secondId}`);

  // 5. With autoplay switched off, a finished video simply stops, and the choice is remembered for the member.
  const saved = () => page.waitForResponse((r) => r.url().includes('/api/preferences/autoplay') && r.request().method() === 'POST' && r.status() < 300);
  const off = saved();
  await page.locator('#autoplay-toggle').uncheck();
  await off;
  await playToTheEnd();
  await page.waitForTimeout(2500);
  await expect(upNext).toBeHidden();
  await expect(still).toBeHidden();
  expect(here()).toBe(`/watch/${s.secondId}`);
  await page.reload();
  await expect(page.locator('#autoplay-toggle')).not.toBeChecked();

  const on = saved();
  await page.locator('#autoplay-toggle').check();
  await on; // leave the member's settings as they were
});
