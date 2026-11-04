import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { sampleMedia, watchProblems, newMember, uploadSampleVideo } from './helpers.js';

/**
 * AdSense, against a copy of the site with the ad slots switched on. Google's own script is replaced by a tiny stand-in
 * (the test machine does not talk to Google), so what is proved here is OUR side of it: where slots appear and where they
 * never do, the page policy around them, the label, what happens when no ad is available, and that a wide ad cannot
 * break the layout. Whether Google really serves ads can only be seen on the live site with a real AdSense account.
 */
test.describe.configure({ mode: 'serial' });

const creator = { name: 'Ravi Reels', handle: 'ravi.reels', email: 'ravi.reels@example.com' };
const viewer = { name: 'Vani Viewer', handle: 'vani_viewer', email: 'vani.viewer@example.com' };
const admin = { name: 'Asha Admin', handle: 'asha.admin', email: 'asha.admin@example.com' };
const moderator = { name: 'Mohan Mod', handle: 'mohan.mod', email: 'mohan.mod@example.com' };
const WHO = ['anon', 'creator', 'viewer', 'admin', 'moderator'];
const TITLE = 'Monsoon on the terrace';
const GOOGLE_HOST = 'pagead2.googlesyndication.com';

const s = {};
let adState = 'filled'; // what the stand-in for Google does: 'filled' | 'unfilled' | 'wide'

const googleStandIn = (state) => `
(function () {
  window.__adsLibraryLoaded = (window.__adsLibraryLoaded || 0) + 1;
  var queue = (window.adsbygoogle = window.adsbygoogle || []);
  function fill() {
    document.querySelectorAll('ins.adsbygoogle').forEach(function (ins) {
      if (ins.getAttribute('data-ad-status')) return;
      if (${JSON.stringify(state)} === 'unfilled') { ins.setAttribute('data-ad-status', 'unfilled'); return; }
      ins.setAttribute('data-ad-status', 'filled');
      var box = document.createElement('div');
      box.textContent = 'Test advertisement';
      box.style.cssText = 'height:90px;background:#ddd;color:#000;width:' + (${JSON.stringify(state)} === 'wide' ? '970px' : '100%') + ';';
      ins.appendChild(box);
    });
  }
  var original = queue.push;
  queue.push = function () { var r = original.apply(queue, arguments); fill(); return r; };
  fill();
})();`;

test.beforeAll(async ({ browser }, testInfo) => {
  const { baseURL, viewport } = testInfo.project.use;
  s.base = baseURL;
  s.hosts = new Set();
  for (const who of WHO) {
    const context = await browser.newContext({ baseURL, viewport });
    context.on('request', (r) => {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http')) s.hosts.add(url.host);
    });
    await context.route(`https://${GOOGLE_HOST}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: googleStandIn(adState) }),
    );
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

const csp = (response) => response.headers()['content-security-policy'] ?? '';
const slots = (page) => page.locator('.adslot');

// ------------------------------------------------------------------------------------------------ set up

test('set up: a creator publishes a video; a viewer, a moderator and an admin join', async () => {
  await newMember(s.creator.page, creator);
  s.videoId = await uploadSampleVideo(s.creator.page, { title: TITLE, description: 'Rain, tea, and a very loud tin roof.' });
  await newMember(s.viewer.page, viewer);
  for (const [who, person, role] of [['admin', admin, 'admin'], ['moderator', moderator, 'moderator']]) {
    await newMember(s[who].page, person);
    const r = await s[who].page.request.post(`/__e2e/promote?email=${encodeURIComponent(person.email)}&role=${role}`);
    expect((await r.json()).updated).toBe(1);
  }
});

// ------------------------------------------------------------------------------------------------ where ads are not

test('no ads, no outside requests and the strictest page policy on every page except a video page', async () => {
  const { page } = s.anon;
  s.hosts.clear();
  for (const url of ['/', '/trending', `/@${creator.handle}`, '/results?q=monsoon', '/help', '/help/tips', '/legal/terms', '/contact', '/login', '/signup']) {
    const response = await page.goto(url);
    expect(response.status(), url).toBe(200);
    await expect(slots(page), `${url} must not have an ad slot`).toHaveCount(0);
    expect(await page.locator('ins.adsbygoogle').count(), url).toBe(0);
    expect(await page.locator(`script[src*="${GOOGLE_HOST}"]`).count(), url).toBe(0);
    const policy = csp(response);
    expect(policy, url).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic';/);
    expect(policy, url).not.toMatch(/unsafe-|https:|http:/);
  }
  expect([...s.hosts], 'every request stayed on this site').toEqual([new URL(s.base).host]);
});

// ------------------------------------------------------------------------------------------------ where they are

test('a public video shows two labelled slots to a stranger and to a member, under a policy that is loosened only for the ad library', async () => {
  for (const who of ['anon', 'viewer']) {
    const { page } = s[who];
    adState = 'filled';
    const response = await page.goto(`/watch/${s.videoId}`);
    const policy = csp(response);
    // The ad library needs a looser script policy; everything else about the policy stays shut.
    expect(policy).toMatch(/script-src [^;]*'nonce-[^']+'/);
    expect(policy).toMatch(/script-src [^;]*'strict-dynamic'/);
    for (const rule of ["default-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) expect(policy, rule).toContain(rule);
    expect(policy).not.toMatch(/script-src [^;]*\*/);

    await expect(slots(page)).toHaveCount(2); // one under the player, one beside it
    for (const slot of await slots(page).all()) {
      await expect(slot.locator('.adlabel')).toHaveText('Advertisement');
      await expect(slot.locator('ins.adsbygoogle')).toHaveAttribute('data-ad-client', 'ca-pub-1234567890123456');
      await expect(slot).toContainText('Test advertisement');
    }
    await page.waitForFunction(() => window.__adsLibraryLoaded === 1);
    expect(await page.evaluate(() => ({ pushes: window.adsbygoogle.length, npa: window.adsbygoogle.requestNonPersonalizedAds }))).toEqual({ pushes: 2, npa: 1 }); // one request per slot, non-personalised by default

    // An ad never sits on top of the picture.
    const stage = await page.locator('.stage').boundingBox();
    for (const slot of await slots(page).all()) {
      const b = await slot.boundingBox();
      const overlaps = b.x < stage.x + stage.width && b.x + b.width > stage.x && b.y < stage.y + stage.height && b.y + b.height > stage.y;
      expect(overlaps, 'an ad slot overlaps the video').toBe(false);
    }
    await expect(page.locator('.stage .adslot')).toHaveCount(0);
  }

  // The looser policy still refuses an inline event handler, which is how most injected attacks run.
  const { page, watcher } = s.anon;
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<img id="probe" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=" onload="window.__ranInline=1">');
  });
  await expect.poll(() => watcher.problems.some((p) => /CSP violation: script-src/.test(p))).toBe(true);
  expect(await page.evaluate(() => window.__ranInline)).toBeUndefined();
  watcher.expected(/CSP violation: script-src|Executing inline event handler violates|Refused to execute inline event handler/);
});

test('when no ad is available the slot disappears instead of leaving a labelled empty box', async () => {
  const { page } = s.anon;
  adState = 'unfilled';
  await page.goto(`/watch/${s.videoId}`);
  await page.waitForFunction(() => window.__adsLibraryLoaded === 1);
  await expect(page.locator('ins.adsbygoogle[data-ad-status="unfilled"]')).toHaveCount(2);
  for (const slot of await slots(page).all()) await expect(slot).toBeHidden();
  await expect(page.locator('.adlabel:visible')).toHaveCount(0); // the label goes with the slot: nothing says "Advertisement" above empty space
  adState = 'filled';
});

test('a very wide ad cannot push the page sideways on a phone', async () => {
  const { page } = s.anon;
  adState = 'wide';
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto(`/watch/${s.videoId}`);
  await expect(page.locator('.adslot').first()).toContainText('Test advertisement');
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  for (const slot of await slots(page).all()) {
    const b = await slot.boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(375 + 0.5);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  adState = 'filled';
});

// ------------------------------------------------------------------------------------------------ who never sees them

test('the owner, a moderator and an admin never see ads, and their pages keep the strict policy', async () => {
  for (const who of ['creator', 'moderator', 'admin']) {
    const { page } = s[who];
    const response = await page.goto(`/watch/${s.videoId}`);
    await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(slots(page), who).toHaveCount(0);
    expect(await page.locator(`script[src*="${GOOGLE_HOST}"]`).count(), who).toBe(0);
    expect(csp(response), who).not.toMatch(/unsafe-|https:/);
  }
});

test('an open report pauses ads on the video until a moderator decides', async () => {
  const { page: viewerPage } = s.viewer;
  await viewerPage.goto(`/report?type=video&id=${s.videoId}`);
  await viewerPage.getByLabel('What is wrong?').selectOption('misleading');
  await viewerPage.getByRole('button', { name: 'Send report' }).click();
  await expect(viewerPage.getByText(/A moderator will look at this/)).toBeVisible();

  const { page: stranger } = s.anon;
  await stranger.goto(`/watch/${s.videoId}`);
  await expect(slots(stranger)).toHaveCount(0); // paused while the report is open, for everyone

  const { page: staff } = s.admin;
  await staff.goto('/admin/reports');
  const card = staff.locator('form', { has: staff.getByRole('button', { name: 'Save decision' }) }).first();
  await card.getByLabel('Dismiss').check();
  await card.getByRole('button', { name: 'Save decision' }).click();
  await expect(staff.getByText('Saved.')).toBeVisible();

  await stranger.goto(`/watch/${s.videoId}`);
  await expect(slots(stranger)).toHaveCount(2); // a dismissed report gives the ads back
});

test('an unlisted video shows no ads, and a private one cannot be opened by a stranger at all', async () => {
  const { page: owner } = s.creator;
  const setVisibility = async (value) => {
    await owner.goto(`/studio/videos/${s.videoId}`);
    await owner.getByLabel('Who can watch').selectOption(value);
    await owner.getByRole('button', { name: 'Save changes' }).click();
    await expect(owner).toHaveURL(/saved=1/);
  };
  const { page } = s.anon;
  try {
    await setVisibility('unlisted');
    const unlisted = await page.goto(`/watch/${s.videoId}`);
    expect(unlisted.status()).toBe(200); // anyone with the link can watch
    await expect(slots(page)).toHaveCount(0);

    await setVisibility('private');
    const hidden = await page.goto(`/watch/${s.videoId}`);
    expect(hidden.status()).toBe(404);
    s.anon.watcher.expected(/status of 404/);
  } finally {
    await setVisibility('public');
  }
  await page.goto(`/watch/${s.videoId}`);
  await expect(slots(page)).toHaveCount(2);
});

// ------------------------------------------------------------------------------------------------ accessibility

for (const scheme of ['light', 'dark']) {
  test(`the video page with ads passes the accessibility scan (${scheme} theme)`, async () => {
    const { page } = s.viewer;
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/watch/${s.videoId}`);
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), scheme);
    await expect(slots(page)).toHaveCount(2);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    const found = axe.violations.map((v) => `${v.impact} ${v.id}: ${v.help}\n   ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n   ')}`);
    expect(found.join('\n'), 'accessibility problems').toBe('');
    await page.emulateMedia({ colorScheme: null });
  });
}
