import { defineConfig } from '@playwright/test';
import { loadGateConfig, requireInvite } from './tests/browser/release-gate.mjs';

const deployed = process.env.JUSTUP_SMOKE_URL;
const acceptance = process.env.JUSTUP_ACCEPTANCE_CONFIG;
const accepting = acceptance !== undefined;
if (deployed && accepting) throw new Error('Choose read-only smoke or the disposable-account acceptance mode.');
const gate = accepting ? loadGateConfig(acceptance) : null;
if (accepting) requireInvite(process.env.JUSTUP_ACCEPTANCE_INVITE);
const live = Boolean(deployed || gate);
// Playwright's automatic error-context markdown is independent of trace/media options.
if (live) process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
const port = Number(process.env.JUSTUP_TEST_PORT || '4183');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged JUSTUP_TEST_PORT.');
const baseURL = gate?.origin || deployed || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: gate ? '**/acceptance.spec.mjs' : deployed ? '**/deployed.spec.mjs' : '**/*.spec.mjs',
  testIgnore: live ? [] : ['**/deployed.spec.mjs', '**/acceptance.spec.mjs'],
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'en-US',
    trace: live ? 'off' : 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },
  webServer: live ? undefined : [{
    command: `node node_modules/vite/bin/vite.js preview --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    stderr: 'ignore',
    timeout: 30_000,
  }, { command: "node tests/browser/public-server.mjs", url: `http://127.0.0.1:${process.env.JUSTUP_PUBLIC_TEST_PORT || 4207}/`, reuseExistingServer: false, timeout: 30_000 }],
});
