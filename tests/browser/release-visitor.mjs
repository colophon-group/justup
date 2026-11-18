// Exercise signed-out search and its handoff through the candidate's own UI and API.
import { expect } from '@playwright/test';
import { decodeResults } from '../../web/src/api/decode.ts';

const DAY = 86_400_000;
const draft = '  Unsent refinement for the release check  ';

export async function exerciseVisitorSearch(page, read, { query, sourceUrl, companyId }, clock = Date.now) {
  await expect(page.locator('#header-sign-in')).toBeVisible();
  await page.locator('#query').fill(query);
  await page.locator('#job-search button[type=submit]').click();
  await page.locator('#search-results').waitFor({ state: 'visible', timeout: 90_000 });
  await page.locator('#search-results').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('a.posting-link').evaluateAll(
    (links, url) => links.some(link => link.href === url), sourceUrl
  ), { timeout: 15_000 }).toBe(true);

  const searches = await read('/api/v1/visitor/searches');
  const items = searches.json?.items;
  expect(searches.status === 200 && Array.isArray(items) && items.length === 1).toBe(true);
  const [search] = items;
  expect(search.status === 'ready' && search.query === query && search.revision === 1
    && search.configuration?.residualAi === null).toBe(true);
  const resultsPath = `/api/v1/visitor/searches/${encodeURIComponent(search.id)}/results?revision=${search.revision}`;
  const response = await read(resultsPath);
  expect(response.status).toBe(200);
  const results = decodeResults(response.json), asOf = clock();
  expect(results.searchId === search.id && results.revision === search.revision
    && results.items.some(job => job.sourceUrl === sourceUrl && job.company.id === companyId)
    && results.items.every(job => {
      const observed = Date.parse(job.firstObserved);
      return observed >= asOf - 14 * DAY && observed <= asOf - 2 * DAY;
    })
    && results.hiddenMatches.status === 'exact').toBe(true);
  const guest = await read('/api/v1/session');
  expect(guest.status === 200 && guest.json?.user === null && guest.json?.access?.kind === 'guest').toBe(true);
  expect((await read('/api/v1/searches')).status).toBe(401);

  await page.locator('#query').fill(draft);
  await expect.poll(async () => {
    const workspace = await read('/api/v1/visitor/workspace');
    return workspace.status === 200 && workspace.json?.state?.activeSearchId === search.id
      && workspace.json?.state?.drafts?.[search.id] === draft;
  }).toBe(true);
  return { search, resultsPath };
}

export async function verifyVisitorHandoff(page, read, previous, authentication) {
  expect(authentication.visitorHandoff?.status).toBe('complete');
  await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
  await expect(page.locator('#query')).toHaveValue(draft);
  const listing = await read('/api/v1/searches');
  const items = listing.json?.items;
  expect(listing.status === 200 && Array.isArray(items) && items.length === 1).toBe(true);
  const [owned] = items;
  const { search } = previous;
  expect(owned.id === search.id && owned.revision === search.revision && owned.query === search.query
    && owned.status === 'ready').toBe(true);
  expect(owned.configuration).toEqual(search.configuration);
  const workspace = await read('/api/v1/workspace');
  expect(workspace.status === 200 && workspace.json?.state?.activeSearchId === search.id
    && workspace.json?.state?.drafts?.[search.id] === draft).toBe(true);
  expect((await read(previous.resultsPath)).status).toBe(403);
}
