// Observe the application's own edge stream through a real browser session.
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { liveResultsPath, validEventId } from '../../web/src/api/liveResults.ts';
import { decodeResults } from '../../web/src/api/decode.ts';

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

export async function verifyReleaseResumeIdentity(page, search, eventId) {
  if (!validEventId(eventId)) throw new Error('Reopened browser stream has an invalid event identity.');
  // A well-formed unknown token also opens successfully. Ask for one frame
  // with the exact observed header and require the server to recognize it.
  const resumed = await page.evaluate(async ({ path, eventId, searchId, revision, deadline }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const response = await fetch(path, {
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': eventId },
      });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'text/event-stream' || !response.body) return false;
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '', size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        size += value.byteLength;
        if (size > 1_048_640) return false;
        text += decoder.decode(value, { stream: true });
        for (let end = text.indexOf('\n\n'); end !== -1; end = text.indexOf('\n\n')) {
          const lines = text.slice(0, end).split('\n');
          text = text.slice(end + 2);
          const payload = lines.find(line => line.startsWith('data: '));
          if (!payload) continue;
          const snapshot = JSON.parse(payload.slice(6));
          return lines.includes('event: snapshot') && snapshot.schemaVersion === 1
            && snapshot.scope === 'active_search' && snapshot.searchId === searchId
            && snapshot.revision === revision && snapshot.reason === 'resumed';
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, { path: accountStreamUrl(search), eventId,
    searchId: search.id, revision: search.revision, deadline: snapshotDeadlineMs });
  if (!resumed) throw new Error('The preview server did not recognize the browser resume identity.');
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
    const reconnectSnapshotMs = await connectedSnapshot(page, response);
    await verifyReleaseResumeIdentity(page, acceptedSearch, response.request().headers()['last-event-id']);
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
  return liveResultsPath('account', search.id, search.revision, 'en');
}

// Qualify an actual arrival while holding one reader and one connected response.
// A later operator readback ties the observed import generation to the source receipt.
export async function verifyReleaseFeedArrival(page, { opening, search, sourceUrl, baselineGeneration, read, observeImport, timeout = 150_000 }) {
  if (!isSearchStream(opening.response, search) || search.configuration?.residualAi !== null) {
    throw new Error('Feed arrival needs the exact primary-only search stream.');
  }
  const resultsPath = `/api/v1/searches/${encodeURIComponent(search.id)}/results?revision=${search.revision}&limit=50`;
  const results = async () => {
    const { status, json } = await read(resultsPath);
    const page = decodeResults(json), asOf = Date.parse(json.asOf);
    if (status !== 200 || page.searchId !== search.id || page.revision !== search.revision
      || page.ai.status !== 'not_required' || page.coverage?.kind !== 'imported_snapshot' || page.coverage.stale !== false
      || !Number.isFinite(asOf) || Math.abs(Date.now() - asOf) >= 30_000) throw new Error('Search results are out of scope or stale.');
    return { items: page.items, asOf };
  };
  const before = await results();
  if (!before.items.some(item => item.sourceUrl === sourceUrl)) throw new Error('The reviewed reading anchor is absent.');
  const row = await page.evaluateHandle(url => [...document.querySelectorAll('#feed a.posting-link')]
    .find(link => link.href === url)?.closest('[data-job]') ?? null, sourceUrl);
  let selection;
  try {
    selection = await row.evaluateHandle(anchor => {
      if (!anchor?.isConnected) throw new Error('The reading anchor is outside the rendered results.');
      anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
      const link = anchor.querySelector('.posting-link');
      link.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(link);
      const selected = getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
      return { anchor, link, text: selected.toString() };
    });
    // Let the application settle the scroll so this measures an idle reader.
    await page.waitForTimeout(250);
    const anchorTop = await selection.evaluate(({ anchor, link, text }) => {
      const bounds = anchor.getBoundingClientRect();
      if (document.activeElement !== link || !text || getSelection().toString() !== text
        || scrollY <= 0 || bounds.bottom <= 0 || bounds.top >= innerHeight) throw new Error('Could not establish the reader position.');
      return bounds.top;
    });
    if (await observeImport() !== baselineGeneration) throw new Error('Import changed before the reader baseline.');
    await expect(page.locator('#new-results')).toHaveCount(0);
    const startedAt = Date.now();
    const arrival = await Promise.race([
      page.waitForFunction(asOf => {
        const found = [...document.querySelectorAll('#feed [data-job].is-new')]
          .find(item => Date.parse(item.querySelector('time')?.dateTime) > asOf);
        return found ? { id: found.dataset.job, sourceUrl: found.querySelector('.posting-link')?.href,
          firstObserved: found.querySelector('time').dateTime } : false;
      }, before.asOf, { timeout }).then(async handle => {
        try { return await handle.jsonValue(); } finally { await handle.dispose(); }
      }),
      opening.response.finished().then(() => { throw new Error('The stream closed before the feed arrival.'); }),
    ]);
    const observedAfterMs = Date.now() - startedAt;
    if (observedAfterMs < 0 || observedAfterMs > timeout) throw new Error('The feed arrival missed its observation window.');
    const generation = await observeImport();
    if (generation === baselineGeneration || before.items.some(item => item.id === arrival.id)) throw new Error('The observed posting did not come from a new import.');
    const after = await results();
    const published = after.items.find(item => item.id === arrival.id);
    if (published?.sourceUrl !== arrival.sourceUrl || published?.firstObserved !== arrival.firstObserved
      || Date.parse(arrival.firstObserved) > after.asOf || await observeImport() !== generation) {
      throw new Error('Could not bind the arriving posting to the new import.');
    }
    const stable = await selection.evaluate(({ anchor, link, text }, top) => anchor.isConnected && link.isConnected
      && anchor.querySelector('.posting-link') === link && document.activeElement === link && getSelection().toString() === text
      && Math.abs(anchor.getBoundingClientRect().top - top) <= 1, anchorTop);
    if (!stable) throw new Error('The feed arrival moved the reader or replaced the selected row.');
    const rendered = page.locator(`[data-job=${JSON.stringify(arrival.id)}]`);
    await expect(rendered).toHaveCount(1);
    await expect(page.locator('#live-arrivals')).toContainText(/new matching positions? added\./);
    await page.locator('#new-results').click();
    await expect(rendered.locator('.posting-link')).toBeFocused();
    const sourcePostingSha256 = createHash('sha256').update(JSON.stringify([arrival.id, arrival.sourceUrl, arrival.firstObserved])).digest('hex');
    return { baselineGeneration, baselineAsOf: new Date(before.asOf).toISOString(),
      arrivalGeneration: generation, firstObserved: arrival.firstObserved,
      sourcePostingSha256, observedAfterMs, readerPreserved: true };
  } finally {
    await selection?.dispose();
    await row.dispose();
  }
}
