// Real fixture shutdown must cover pre-TLS sockets, live delivery and held committed HTTP replies.
import { expect, test } from '@playwright/test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startVisitorRuntime } from '../assembled/visitor-runtime.mjs';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1100 } });
test('assembled shutdown stops accepting and closes pre-TLS, streaming and held response connections', async ({ page }) => {
  const runtime = await startVisitorRuntime();
  let partial, held, closing, deadline;
  try {
    await page.goto(runtime.origin); await page.locator('#query').fill('Engineer'); await page.locator('#job-search button[type=submit]').click();
    await expect(page.locator('[data-job="assembled-engineer"]')).toBeVisible();
    await expect.poll(() => runtime.liveConnections()).toBe(1);
    const address = new URL(runtime.origin);
    partial = connect({ host: address.hostname, port: Number(address.port) });
    partial.on('error', () => {});
    await once(partial, 'connect');
    // The listener has accepted another HTTP request after the raw TCP connect,
    // while that first socket deliberately never sends a TLS handshake.
    held = runtime.holdNext('GET', '/session');
    const waiting = page.request.get(runtime.origin + '/api/v1/session').catch(() => null);
    await held.arrived;
    runtime.dropLiveConnections();
    closing = runtime.close();
    await Promise.race([closing, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Fixture shutdown stranded an accepted connection')), 2000); })]);
    clearTimeout(deadline);
    await waiting;
    expect(runtime.liveConnections()).toBe(0);
    const refused = connect({ host: address.hostname, port: Number(address.port) });
    const failure = await once(refused, 'error');
    expect(failure[0].code).toBe('ECONNREFUSED');
    refused.destroy();
    await runtime.close();
  } finally {
    clearTimeout(deadline); partial?.destroy(); held?.release();
    await (closing ?? runtime.close());
  }
});
