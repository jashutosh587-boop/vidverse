import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests. `npm run e2e` starts two copies of the website (one plain, one with the AdSense slots switched on),
 * drives a real Chrome through the main journeys, and checks accessibility and phone-sized layouts.
 *
 * Needs ffmpeg on the PATH (the same as the website itself) and a Chromium that can play H.264, which Playwright's
 * own "chromium" download does. To use another browser binary: PLAYWRIGHT_CHROME=/path/to/chrome npm run e2e
 */
const MAIN = 4173;
const ADS = 4174;
const executablePath = process.env.PLAYWRIGHT_CHROME || undefined;
const launchOptions = { executablePath, args: ['--autoplay-policy=no-user-gesture-required'] };

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'e2e/results',
  use: { baseURL: `http://127.0.0.1:${MAIN}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions },
  projects: [
    { name: 'desktop', testMatch: /journey\.spec\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'phone', testMatch: /phone\.spec\.js/, use: { ...devices['Pixel 7'], launchOptions } },
    { name: 'ads', testMatch: /ads\.spec\.js/, use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${ADS}`, launchOptions } },
  ],
  webServer: [
    { command: 'node e2e/server.mjs', env: { E2E_PORT: String(MAIN) }, url: `http://127.0.0.1:${MAIN}/api/health`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe' },
    { command: 'node e2e/server.mjs', env: { E2E_PORT: String(ADS), E2E_ADS: '1' }, url: `http://127.0.0.1:${ADS}/api/health`, reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe' },
  ],
});
