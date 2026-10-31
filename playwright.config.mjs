import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory prototype',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stderr: 'ignore',
    timeout: 30_000,
  },
});
