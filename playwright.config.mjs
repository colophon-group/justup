import { defineConfig } from '@playwright/test';

const deployed = process.env.JUSTUP_SMOKE_URL;
const port = Number(process.env.JUSTUP_TEST_PORT || '4183');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged JUSTUP_TEST_PORT.');
const baseURL = deployed || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: deployed ? '**/deployed.spec.mjs' : '**/*.spec.mjs',
  testIgnore: deployed ? [] : ['**/deployed.spec.mjs'],
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: deployed ? undefined : {
    command: `node node_modules/vite/bin/vite.js preview --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    stderr: 'ignore',
    timeout: 30_000,
  },
});
