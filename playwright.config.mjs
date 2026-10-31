import { defineConfig } from '@playwright/test';

const deployed = process.env.JUSTUP_SMOKE_URL;
const baseURL = deployed || 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: deployed ? '**/deployed.spec.mjs' : '**/flows.spec.mjs',
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
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory prototype',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stderr: 'ignore',
    timeout: 30_000,
  },
});
