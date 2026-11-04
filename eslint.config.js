import js from '@eslint/js';
import globals from 'globals';

/**
 * The server, scripts and tests are modern ES modules for Node. The files in public/js are plain scripts that run in the
 * browser (no build step), so they get browser globals and script mode. Playwright's page.evaluate() callbacks run in the
 * browser too, which is why e2e files may mention `document` and `window`.
 */
export default [
  { ignores: ['node_modules/**', 'data/**', 'e2e/results/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, Hls: 'readonly' } },
    rules: { 'no-var': 'off', 'prefer-const': 'off' },
  },
  {
    files: ['e2e/**/*.js', 'e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty-pattern': 'off' }, // Playwright needs `async ({}, testInfo)` to know no fixtures are wanted
  },
];
