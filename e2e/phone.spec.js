import { test, expect, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { hotp, totpStep } from '../src/lib/totp.js';
import { sampleMedia, watchProblems, newMember, uploadSampleVideo, canPlayH264, playFor } from './helpers.js';

/**
 * The same website on a phone: a Pixel 7 sized screen, touch and no keyboard. Nothing may be wider than the screen (not
 * even at 320 px, the narrowest phones still in use), the menu and the help assistant work by touch, controls are big
 * enough for a thumb, the video plays, and the accessibility scan still passes at this size.
 */
test.describe.configure({ mode: 'serial' });

const creator = { name: 'Pia Pocket', handle: 'pia.pocket', email: 'pia.pocket@example.com' };
const viewer = { name: 'Pavan Palm', handle: 'pavan_palm', email: 'pavan.palm@example.com' };
const WHO = ['anon', 'creator', 'viewer'];
const TITLE = 'Tea stall on the ghat road';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const s = {};

test.beforeAll(async ({ browser }, testInfo) => {
  const { baseURL } = testInfo.project.use;
  for (const who of WHO) {
    const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
    s[who] = { context, watcher: watchProblems(context), page: await context.newPage() };
  }
  sampleMedia();
});

test.afterAll(async () => {
  for (const who of WHO) await s[who]?.context.close();
});

test.afterEach(async ({}, testInfo) => {
  const all = WHO.flatMap((who) => s[who].watcher.problems.map((p) => `[${who}] ${p}`));
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const who of WHO) await s[who].page.screenshot({ path: testInfo.outputPath(`${who}.png`), fullPage: true }).catch(() => {});
  }
  for (const who of WHO) s[who].watcher.clear();
  expect(all, 'the browser reported problems').toEqual([]);
});

/** Whatever sticks out past the right edge of the screen and is not inside something that scrolls on its own. */
async function stickingOut(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
      }
      return false;
    };
    const out = [];
    if (doc.scrollWidth > doc.clientWidth) out.push(`the page scrolls sideways: ${doc.scrollWidth} wide on a ${doc.clientWidth} wide screen`);
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= limit + 1) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || clipped(el)) continue;
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      out.push(`${el.tagName.toLowerCase()}${cls} ends at ${Math.round(r.right)} on a ${limit} wide screen`);
    }
    return out.slice(0, 6);
  });
}

/** Controls too small for a thumb: under 24 px either way (the WCAG 2.2 minimum), or under 40 px tall for buttons and fields. */
async function smallTargets(page) {
  return page.evaluate(() => {
    const selector = 'button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, summary, a.btn, a.iconbtn, a.chip, [role=button], [role=tab]';
    const found = [];
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest('[hidden], [inert], [aria-hidden="true"]')) continue; // includes the spam trap on the contact form
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 && r.height <= 2) continue; // visually hidden helpers
      const solid = el.matches('.btn, .iconbtn, button:not(.linkbtn), input, select, textarea');
      if (r.width < 24 || r.height < 24 || (solid && r.height < 40)) {
        const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        found.push(`${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : ''} "${label}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return found.slice(0, 8);
  });
}

async function axeProblems(page, where) {
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return axe.violations.map((v) => `${where} ${v.impact} ${v.id}: ${v.help}\n      ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n      ')}`);
}

// ------------------------------------------------------------------------------------------------ arriving

test('the front page fits the screen; the menu opens and closes by touch and is out of reach of the keyboard while closed', async () => {
  const { page } = s.anon;
  await page.goto('/');
  expect(await stickingOut(page)).toEqual([]);

  const toggle = page.getByRole('button', { name: 'Show or hide the menu' });
  const rail = page.locator('#rail');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Closed: the menu is off the left edge, and its links cannot be reached by the Tab key either.
  expect(await rail.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
  await expect(rail.getByRole('link', { name: 'Trending' })).toBeHidden();
  await page.locator('body').press('Tab'); // first the skip link
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#rail')), 'a closed menu must not take the focus').toBe(false);
  }

  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rail.getByRole('link', { name: 'Trending' })).toBeVisible();
  await expect.poll(async () => (await rail.boundingBox()).x).toBeGreaterThanOrEqual(0);
  const box = await rail.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);

  // Tapping the page outside the menu closes it, and the focus is not lost.
  await page.locator('.main').tap({ position: { x: page.viewportSize().width - 20, y: 200 } });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rail.getByRole('link', { name: 'Trending' })).toBeHidden();

  // A link in the menu works.
  await toggle.tap();
  await rail.getByRole('link', { name: 'Trending' }).tap();
  await expect(page).toHaveURL(/\/trending$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Trending' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Search sits on its own row under the logo and is wide enough to type in.
  const q = page.getByRole('combobox', { name: 'Search videos and channels' });
  expect((await q.boundingBox()).width).toBeGreaterThan(200);
  await q.fill('harbour');
  await q.press('Enter');
  await expect(page).toHaveURL(/\/results\?q=harbour/);
});

test('someone on a phone can find how to create an account without a desktop-only button', async () => {
  const { page } = s.anon;
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).tap();
  await expect(page.getByRole('heading', { name: /Sign in/ })).toBeVisible();
  await page.getByRole('link', { name: 'Create an account' }).tap();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  expect(await stickingOut(page)).toEqual([]);
});

test('a creator joins and uploads a video from a phone', async () => {
  const { page } = s.creator;
  await newMember(page, creator);
  await page.goto('/studio/upload');
  expect(await stickingOut(page)).toEqual([]);
  const id = await uploadSampleVideo(page, { title: TITLE, description: 'Chai, steam and a very slow afternoon.', tags: 'chai, street' });
  expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  s.videoId = id;
  await page.goto('/studio/videos');
  expect(await stickingOut(page)).toEqual([]);
  await expect(page.getByRole('row', { name: new RegExp(TITLE) })).toContainText('Ready');
});

test('two-step verification can be turned on from a phone: the key can be typed in and the QR code fits', async () => {
  const { page } = s.creator;
  await page.goto('/settings/security');
  expect(await stickingOut(page)).toEqual([]);
  await page.getByRole('button', { name: 'Set up two-step verification' }).tap();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
  expect(box.width).toBeGreaterThan(120); // big enough for another phone, or a laptop camera, to scan
  expect(await stickingOut(page)).toEqual([]);
  const key = (await page.locator('code.secret').textContent()).replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/); // on a phone the person types or pastes this into the authenticator app
  await page.getByLabel('Code from the app').fill(hotp(key, totpStep(Date.now())));
  await page.getByRole('button', { name: 'Turn on' }).tap();
  await expect(page.getByRole('heading', { name: 'Two-step verification is on' })).toBeVisible();
  expect(await stickingOut(page)).toEqual([]); // the recovery codes
  await page.getByRole('link', { name: 'I have saved them' }).tap();
});

// ------------------------------------------------------------------------------------------------ watching

test('a viewer opens the video from the front page by touch, and the video plays', async () => {
  const { page } = s.viewer;
  await newMember(page, viewer);
  await page.goto('/');
  await page.getByRole('link', { name: TITLE }).first().tap();
  await expect(page).toHaveURL(new RegExp(`/watch/${s.videoId}$`));
  expect(await stickingOut(page)).toEqual([]);

  // The picture fills the width of the screen without being cut off.
  const stage = await page.locator('.stage').boundingBox();
  expect(stage.x).toBeGreaterThanOrEqual(0);
  expect(stage.x + stage.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
  expect(stage.width).toBeGreaterThan(page.viewportSize().width * 0.9);

  test.skip(!(await canPlayH264(page)), 'this browser build cannot decode H.264, so playback cannot be proven here');
  await playFor(page, 3);
  const state = await page.evaluate(() => {
    const v = document.getElementById('player');
    return { paused: v.paused, width: v.videoWidth, error: v.error?.message ?? null };
  });
  expect(state.error).toBeNull();
  expect(state.paused).toBe(false);
  expect(state.width).toBeGreaterThan(0);

  // The quality and speed lists are in reach and can be changed.
  for (const sel of ['#quality', '#speed']) {
    const b = await page.locator(sel).boundingBox();
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
  }
  await page.locator('#speed').selectOption('1.25');
  expect(await page.evaluate(() => document.getElementById('player').playbackRate)).toBe(1.25);
  await page.locator('#speed').selectOption('1');
  await page.keyboard.press('k');
});

test('like, subscribe, save and comment work by touch, and every action button is inside the screen', async () => {
  const { page } = s.viewer;
  await page.goto(`/watch/${s.videoId}`);
  const width = page.viewportSize().width;
  for (const el of await page.locator('.actions .btn, .actions summary').all()) {
    const b = await el.boundingBox();
    if (!b) continue;
    expect(b.x, 'an action button starts off screen').toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, 'an action button ends off screen').toBeLessThanOrEqual(width + 0.5);
  }

  const like = page.getByRole('button', { name: /^Like \d+$/ });
  await like.tap();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Subscribe', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Subscribed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Watch later/ }).tap();
  await expect(page.getByRole('button', { name: /Saved/ })).toBeVisible();

  await page.getByLabel('Add a comment').fill('Watching this on the bus.');
  await page.getByRole('button', { name: 'Comment', exact: true }).tap();
  await expect(page.locator('.commentlist')).toContainText('Watching this on the bus.');
  expect(await stickingOut(page)).toEqual([]);
});

test('the help assistant opens inside the screen, answers, and closes with its own button', async () => {
  const { page } = s.viewer;
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Help', exact: true });
  const size = (await toggle.boundingBox());
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
  await toggle.tap();
  const panel = page.getByRole('dialog', { name: 'Help assistant' });
  await expect(panel).toBeVisible();
  const { x, y, width, height } = await panel.boundingBox();
  const view = page.viewportSize();
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x + width).toBeLessThanOrEqual(view.width + 0.5);
  expect(y + height).toBeLessThanOrEqual(view.height + 0.5);

  await page.getByLabel('Your question').fill('How do payouts work?');
  await page.getByRole('button', { name: 'Ask' }).tap();
  const answer = panel.locator('.assistant-bot').last();
  await expect(answer).toContainText(/payout/i, { timeout: 10_000 });

  // There is no Escape key on a phone: the close button is the way out and it hands the focus back.
  const close = page.getByRole('button', { name: 'Close help assistant' });
  const cb = await close.boundingBox();
  expect(cb.width).toBeGreaterThanOrEqual(40);
  expect(cb.height).toBeGreaterThanOrEqual(40);
  await close.tap();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

// ------------------------------------------------------------------------------------------------ every kind of page

const PAGES = {
  anon: () => ['/', '/trending', '/results?q=tea', '/results?q=zzzzqqq', `/watch/${s.videoId}`, `/@${creator.handle}`, '/help', '/help/uploading-videos', '/help/tips', '/legal/terms', '/legal/privacy', '/contact', '/login', '/signup', '/forgot-password'],
  viewer: () => ['/', `/watch/${s.videoId}`, '/subscriptions', '/history', '/watch-later', '/liked', '/notifications', '/settings/profile', '/settings/security', '/settings/preferences', '/settings/privacy', `/support/@${creator.handle}`, `/report?type=video&id=${s.videoId}`],
  creator: () => ['/studio', '/studio/videos', '/studio/upload', `/studio/videos/${s.videoId}`, '/studio/earnings', '/studio/payouts'],
};

test('no page is wider than the phone, controls are big enough to tap, and the accessibility scan passes at this size', async () => {
  test.setTimeout(300_000);
  const wide = [];
  const small = [];
  const axe = [];
  let scanned = 0;
  for (const [who, list] of Object.entries(PAGES)) {
    const { page } = s[who];
    for (const url of list()) {
      const response = await page.goto(url);
      expect(response.status(), url).toBeLessThan(400);
      scanned += 1;
      for (const w of await stickingOut(page)) wide.push(`${who} ${url}: ${w}`);
      for (const t of await smallTargets(page)) small.push(`${who} ${url}: ${t}`);
      axe.push(...(await axeProblems(page, `${who} ${url}`)));
    }
  }
  expect(scanned).toBeGreaterThan(30);
  expect(wide.join('\n'), 'pages wider than the screen').toBe('');
  expect(small.join('\n'), 'controls too small to tap').toBe('');
  expect(axe.join('\n'), 'accessibility problems').toBe('');
});

test('at 320 px, the narrowest phones still in use, nothing needs sideways scrolling', async () => {
  test.setTimeout(240_000);
  const wide = [];
  for (const [who, list] of Object.entries(PAGES)) {
    const { page } = s[who];
    await page.setViewportSize({ width: 320, height: 640 });
    for (const url of list()) {
      await page.goto(url);
      for (const w of await stickingOut(page)) wide.push(`${who} ${url}: ${w}`);
    }
    await page.setViewportSize(devices['Pixel 7'].viewport);
  }
  expect(wide.join('\n')).toBe('');
});

test('text can be made twice as large without the page breaking sideways', async () => {
  // WCAG 1.4.4: a person who sets a bigger default font in their phone must still be able to use the page.
  const { page } = s.viewer;
  const wide = [];
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.fontSize = '200%';
    });
  });
  for (const url of ['/', `/watch/${s.videoId}`, '/settings/profile', '/help', '/studio/earnings']) {
    await page.goto(url);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), 'the larger text size was really applied').toBe('32px');
    for (const w of await stickingOut(page)) wide.push(`${url}: ${w}`);
  }
  expect(wide.join('\n')).toBe('');
});
