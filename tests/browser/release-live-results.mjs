// Observe the application's own edge stream through a real browser session.
import { expect } from '@playwright/test';
import { validEventId } from '../../web/src/api/liveResults.ts';

const streamPath = '/api/v1/workspace/events';
const snapshotDeadlineMs = 20_000;

function isWorkspaceStream(response, origin) {
  const url = new URL(response.url());
  return url.origin === origin && url.pathname === streamPath && url.searchParams.get('locale') === 'en'
    && response.request().method() === 'GET';
}

function isSearchStream(response, search) {
  const query = new URL(response.url()).searchParams;
  return query.get('searchId') === search.id && query.get('revision') === String(search.revision);
}

async function connectedSnapshot(page, response) {
  const startedAt = response.request().timing().startTime;
  const headers = response.headers();
  if (response.status() !== 200 || response.request().redirectedFrom() !== null
      || !/^text\/event-stream(?:;|$)/i.test(headers['content-type'] ?? '')
      || !/\bprivate\b/i.test(headers['cache-control'] ?? '')
      || !/\bno-store\b/i.test(headers['cache-control'] ?? '')
      || !/\bnoindex\b/i.test(headers['x-robots-tag'] ?? '')) {
    throw new Error('Invalid preview stream response boundary.');
  }
  // The application displays this only after decoding an accepted snapshot.
  // Record an upper bound that includes browser rendering and test observation.
  const remainingMs = snapshotDeadlineMs - (Date.now() - startedAt);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > snapshotDeadlineMs) {
    throw new Error('Preview stream response missed its deadline.');
  }
  await Promise.race([
    expect(page.locator('#live-status')).toContainText('Live results connected.', { timeout: remainingMs }),
    response.finished().then(() => { throw new Error('Preview stream closed before its snapshot was observed.'); }),
  ]);
  const observedMs = Math.ceil(Date.now() - startedAt);
  if (observedMs < 0 || observedMs > snapshotDeadlineMs) throw new Error('Preview stream snapshot missed its deadline.');
  return observedMs;
}

export async function openReleaseStream(page, origin, submitSearch) {
  const [response] = await Promise.all([
    page.waitForResponse(value => isWorkspaceStream(value, origin), { timeout: 110_000 }),
    submitSearch(),
  ]);
  if (response.request().headers()['last-event-id'] !== undefined) {
    throw new Error('A new search unexpectedly reused a stream identity.');
  }
  return { response, firstSnapshotMs: await connectedSnapshot(page, response) };
}

export async function verifyReleaseStreamReconnect(page, origin, opening, acceptedSearch, sourceUrl) {
  if (!isSearchStream(opening.response, acceptedSearch)) throw new Error('Initial stream search identity changed.');
  const sourceRow = await page.evaluateHandle(url =>
    [...document.querySelectorAll('a.posting-link')].find(link => link.href === url)?.closest('[data-job]') ?? null,
  sourceUrl);
  try {
    if (!await sourceRow.evaluate(row => Boolean(row?.isConnected))) {
      throw new Error('Expected source row is absent before reconnect.');
    }
    await Promise.all([
      page.waitForEvent('requestfailed', { predicate: request => request === opening.response.request(), timeout: 10_000 }),
      page.locator('#account-open').click(),
    ]);
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#live-status')).toContainText('Live results paused.');
    const [response] = await Promise.all([
      page.waitForResponse(value => isWorkspaceStream(value, origin) && isSearchStream(value, acceptedSearch),
        { timeout: snapshotDeadlineMs }),
      page.keyboard.press('Escape'),
    ]);
    if (!validEventId(response.request().headers()['last-event-id'])) {
      throw new Error('Reopened browser stream did not present its accepted event identity.');
    }
    const reconnectSnapshotMs = await connectedSnapshot(page, response);
    if (!await sourceRow.evaluate(row => row.isConnected
        && [...document.querySelectorAll('[data-job]')].filter(value => value.dataset.job === row.dataset.job).length === 1)) {
      throw new Error('Reconnect replaced or duplicated the accepted source row.');
    }
    return { firstSnapshotMs: opening.firstSnapshotMs, reconnectSnapshotMs };
  } finally {
    await sourceRow.dispose();
  }
}

export function accountStreamUrl(search) {
  return `${streamPath}?${new URLSearchParams({ searchId: search.id, revision: String(search.revision) })}`;
}
