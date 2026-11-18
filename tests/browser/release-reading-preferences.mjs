// Check the disposable account's reading state using the built UI and real API.
import { expect } from '@playwright/test';

async function json(read, path) {
  const response = await read(path);
  if (response.status !== 200) throw new Error('Preview reading-state request failed.');
  return response.json;
}

function reply(page, method, path) {
  const origin = new URL(page.url()).origin;
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === path && response.request().method() === method;
  }, { timeout: 15_000 });
}

function resultsPath(search) {
  return `/api/v1/searches/${encodeURIComponent(search.id)}/results?revision=${search.revision}&limit=12`;
}

async function viewSource(page, read, job) {
  const target = new URL(job.sourceUrl);
  if (target.protocol !== 'https:' || target.origin === new URL(page.url()).origin) {
    throw new Error('Choose an external HTTPS employer posting for the viewed check.');
  }
  const context = page.context();
  const matchesSource = url => url.href === target.href;
  // Keep the actual outbound link and app write, with no request to the employer.
  const stopAtSource = route => route.fulfill({ body: '', contentType: 'text/html' });
  const id = await page.evaluate(value => CSS.escape(value), job.id);
  const row = page.locator(`[data-job=${id}]`);
  const posting = row.locator('a.posting-link');
  expect(await posting.evaluate((link, url) => link.href === url && link.target === '_blank', target.href)).toBe(true);
  let popup;
  await context.route(matchesSource, stopAtSource);
  try {
    const [opened, response] = await Promise.all([
      page.waitForEvent('popup', { timeout: 10_000 }),
      reply(page, 'POST', '/api/v1/viewed'),
      posting.click(),
    ]);
    popup = opened;
    await popup.waitForURL(matchesSource, { timeout: 10_000 });
    expect(response.status() === 200 && response.request().postDataJSON()?.jobId === job.id
      && (await response.json()).viewed === true).toBe(true);
  } finally {
    await popup?.close();
    await context.unroute(matchesSource, stopAtSource);
  }
  await page.bringToFront();
  await expect(row).toHaveClass(/\bviewed\b/);
  const records = (await json(read, '/api/v1/workspace')).viewed;
  const viewed = records?.find(record => record.jobId === job.id);
  if (!viewed || !Number.isFinite(Date.parse(viewed.firstViewedAt))) {
    throw new Error('The accepted employer link did not create a viewed observation.');
  }
  return viewed;
}

export async function exerciseReleaseReadingState(page, read, accepted, sourceUrl) {
  const original = await json(read, resultsPath(accepted));
  const job = original.items?.find(item => item.sourceUrl === sourceUrl);
  const catalogue = await json(read, '/api/v1/search-options');
  const language = catalogue.postingLanguages?.find(value => job?.postingLanguages?.includes(value.id))?.id;
  if (!language) throw new Error('Choose a reviewed employer from the first results page with a selectable posting language.');

  await page.locator('#posting-languages').click();
  await page.locator(`#posting-language-dialog input[value=${JSON.stringify(language)}]`).check();
  const [response] = await Promise.all([
    reply(page, 'PATCH', `/api/v1/searches/${encodeURIComponent(accepted.id)}/options`),
    page.locator('#apply-posting-languages').click(),
  ]);
  expect(response.status()).toBe(200);
  const revised = (await response.json()).search;
  expect(revised?.id === accepted.id && revised.revision === accepted.revision + 1
    && revised.query === accepted.query && revised.status === 'ready'
    && revised.options?.followedOnly === accepted.options?.followedOnly
    && revised.options?.postingLanguages?.length === 1 && revised.options.postingLanguages[0] === language).toBe(true);
  await expect(page.locator('#posting-language-dialog')).toBeHidden();
  const filtered = await json(read, resultsPath(revised));
  expect(filtered.revision === revised.revision && filtered.items?.some(item => item.id === job.id)
    && filtered.items.every(item => item.postingLanguages?.includes(language))).toBe(true);
  return { search: revised, language, viewed: await viewSource(page, read, job) };
}

export async function saveReleaseInterfaceLanguage(page, read, accountId) {
  const before = await json(read, '/api/v1/preferences');
  expect(before.accountId === accountId && before.interfaceLocale === null).toBe(true);
  await page.locator('#account-open').click();
  const [response] = await Promise.all([
    reply(page, 'PATCH', '/api/v1/preferences'),
    page.locator('#interface-language').selectOption('fr'),
  ]);
  expect(response.status()).toBe(200);
  const after = await response.json();
  expect(after.accountId === accountId && after.revision === before.revision + 1
    && after.interfaceLocale === 'fr' && after.resolvedInterfaceLocale === 'fr').toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.keyboard.press('Escape');
}

export async function verifyReleaseReadingState(page, read, { accountId, companyId, search, reading }) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  const [preferences, follows, workspace, searches] = await Promise.all([
    json(read, '/api/v1/preferences'), json(read, '/api/v1/follows'),
    json(read, '/api/v1/workspace'), json(read, '/api/v1/searches'),
  ]);
  expect(preferences.accountId === accountId && preferences.interfaceLocale === 'fr'
    && preferences.resolvedInterfaceLocale === 'fr').toBe(true);
  expect(follows.accountId === accountId && follows.items?.some(item => item.companyId === companyId)).toBe(true);
  const observed = workspace.viewed?.find(record => record.jobId === reading.viewed.jobId);
  expect(observed?.firstViewedAt === reading.viewed.firstViewedAt).toBe(true);
  const saved = searches.items?.find(item => item.id === search.id);
  expect(saved?.revision === search.revision && saved.query === search.query && saved.options?.postingLanguages?.length === 1
    && saved.options.postingLanguages[0] === reading.language).toBe(true);
}
