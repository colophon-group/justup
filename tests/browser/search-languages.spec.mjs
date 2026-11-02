// Browser-only interaction contracts complement the real HTTP/SQLite assembly journey.
import { expect, test } from '@playwright/test';
import { mockApi, search, completed, task, proposal } from './api-fixture.mjs';
const catalogue = { postingLanguages: [{ id: 'de-CH', name: 'Swiss High German' }, { id: 'fr', name: 'French' }, ...Array.from({ length: 24 }, (_, i) => ({ id: `en-x-${String(i).padStart(5, '0')}`, name: `English variant ${i}` }))], emptySelection: 'any', selectionOperator: 'or', queryCombination: 'intersection' };
const initial = () => ({ ...search(), options: { followedOnly: true, postingLanguages: ['it'] } });
for (const [locale, label, find] of [['en', 'Posting languages', 'Find a language'], ['de', 'Anzeigensprachen', 'Sprache suchen'], ['fr', 'Langues des annonces', 'Rechercher une langue'], ['it', 'Lingue degli annunci', 'Cerca una lingua'], ['es', 'Idiomas de los anuncios', 'Buscar un idioma']]) test(`searchable keyboard selection stays independent from ${locale} interface at mobile width`, async ({ browser }) => {
  const context = await browser.newContext({ locale: `${locale}-CH`, viewport: { width: 375, height: 812 } });
  const page = await context.newPage(); let saved = initial();
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': () => ({ items: [saved] }),
    'GET /searches/search-1/results': () => completed([], saved.revision),
    'PATCH /searches/search-1/options': call => { saved = { ...saved, revision: saved.revision + 1, options: { followedOnly: call.body.followedOnly, postingLanguages: call.body.postingLanguages } }; return { search: saved }; },
  });
  await page.goto('/'); await expect(page.locator('#posting-languages')).toBeEnabled();
  await page.locator('#query').fill('Exact unsent français text  ');
  await page.locator('#posting-languages').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: label })).toBeVisible();
  await expect(page.getByLabel(find)).toBeVisible();
  // A selected identifier absent from the latest import stays removable.
  await expect(page.locator('.language-options input[value="it"]')).toBeChecked();
  await page.locator('.language-options input[value="it"]').uncheck();
  await page.getByLabel(find).fill('de-CH');
  await expect(page.locator('.language-options input')).toHaveCount(1);
  await page.locator('.language-options input').focus(); await page.keyboard.press('Space');
  await page.getByLabel(find).fill('English variant');
  for (const box of await page.locator('.language-options input').all()) await box.check();
  await expect(page.locator('.language-options input:checked')).toHaveCount(24);
  expect(await page.locator('#posting-language-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  await expect(page.locator('#posting-languages')).toBeFocused();
  await expect(page.locator('#query')).toHaveValue('Exact unsent français text  ');
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  const writes = calls.filter(call => call.key === 'PATCH /searches/search-1/options');
  expect(writes).toHaveLength(1); expect(writes[0].body).toEqual({ expectedRevision: 1, followedOnly: true, postingLanguages: ['de-CH', ...catalogue.postingLanguages.slice(2).map(item => item.id)].sort() });
  expect(calls.filter(call => /^(POST|PATCH) \/searches(?:$|\/search-1$)/.test(call.key))).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});
test('missing or invalid service semantics disable language selection without inventing success', async ({ page }) => {
  await mockApi(page, { 'GET /searches': { items: [initial()] }, 'GET /searches/search-1/results': completed(), 'GET /search-options': { ...catalogue, selectionOperator: 'and' } });
  await page.goto('/'); await expect(page.locator('#posting-languages')).toBeDisabled();
  await expect(page.locator('#posting-languages-unavailable')).toContainText('unavailable');
});
test('a revision conflict reads canonical options, keeps unsent text and requires explicit reapplication', async ({ page }) => {
  let saved = initial();
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': () => ({ items: [saved] }), 'GET /searches/search-1/results': () => completed([], saved.revision),
    'PATCH /searches/search-1/options': call => {
      if (saved.revision === 1) { saved = { ...saved, revision: 2, options: { followedOnly: true, postingLanguages: ['fr'] } }; return { status: 409, body: { error: { code: 'revision_conflict', message: 'Changed elsewhere' } } }; }
      expect(call.body.expectedRevision).toBe(2);
      saved = { ...saved, revision: 3, options: { followedOnly: call.body.followedOnly, postingLanguages: call.body.postingLanguages } }; return { search: saved };
    },
  });
  await page.goto('/'); await expect(page.locator('#posting-languages')).toBeEnabled();
  await page.locator('#query').fill('My still unsent text'); await page.locator('#posting-languages').click();
  await page.locator('.language-options input[value="de-CH"]').check(); await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).toContainText('could not be confirmed');
  await expect(page.locator('#query')).toHaveValue('My still unsent text');
  await expect(page.locator('#apply-posting-languages')).toBeDisabled();
  await page.locator('#review-posting-languages').click();
  await expect(page.locator('.language-options input[value="fr"]')).toBeChecked();
  await expect(page.locator('.language-options input[value="de-CH"]')).not.toBeChecked();
  await page.locator('.language-options input[value="fr"]').uncheck();
  await page.locator('.language-options input[value="de-CH"]').check();
  await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  await expect(page.locator('#query')).toHaveValue('My still unsent text');
  expect(saved.options).toEqual({ followedOnly: true, postingLanguages: ['de-CH'] });
  expect(calls.filter(call => call.key === 'PATCH /searches/search-1/options')).toHaveLength(2);
  expect(calls.filter(call => call.key === 'POST /searches' || call.key === 'PATCH /searches/search-1')).toHaveLength(0);
});

test('unchanged Apply preserves an existing clarification without issuing an options write', async ({ page }) => {
  const pending = proposal({ query: 'My clarification draft' });
  const saved = { ...initial(), proposal: pending };
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': { items: [saved] }, 'GET /searches/search-1/results': completed(),
    'GET /workspace': { revision: 1, state: { activeSearchId: 'search-1', drafts: { 'search-1': pending.query } }, viewed: [], recoveredDrafts: [] },
  });
  await page.goto('/'); await expect(page.locator('#confirm-search-proposal')).toBeVisible();
  await page.locator('#posting-languages').click(); await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  await expect(page.locator('#confirm-search-proposal')).toBeVisible();
  await expect(page.locator('#query')).toHaveValue(pending.query);
  expect(calls.filter(call => call.key.endsWith('/options') && call.key.startsWith('PATCH'))).toHaveLength(0);
});
test('unchanged Apply leaves the recorded interpretation poll running through completion', async ({ page }) => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const saved = { ...initial(), draft: { query: 'My submitted refinement', taskId: 'recorded-task', status: 'pending' } };
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': { items: [saved] },
    'GET /searches/search-1/results': call => completed([], Number(call.url.searchParams.get('revision'))),
    'GET /tasks/recorded-task': () => held,
  });
  await page.goto('/'); await expect.poll(() => calls.some(call => call.key === 'GET /tasks/recorded-task')).toBe(true);
  await page.locator('#posting-languages').click(); await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).not.toBeVisible();
  finish(task('recorded-task', 'succeeded', { search: { ...saved, draft: undefined, revision: 2, query: saved.draft.query } }));
  await expect(page.locator('#search-status')).toContainText('Search saved.');
  await expect(page.locator('#job-search button[type=submit]')).toBeEnabled();
  await expect(page.locator('#query')).toHaveValue(saved.draft.query);
  expect(calls.filter(call => call.key === 'GET /tasks/recorded-task')).toHaveLength(1);
  expect(calls.filter(call => call.key.endsWith('/options') && call.key.startsWith('PATCH'))).toHaveLength(0);
});

test('a failed changed-options write resumes only the canonically unchanged recorded task and keeps newer text', async ({ page }) => {
  let taskReads = 0, releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const saved = { ...initial(), draft: { query: 'My submitted refinement', taskId: 'recorded-task', status: 'pending' } };
  const finished = { ...saved, draft: undefined, revision: 2, query: saved.draft.query };
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': { items: [saved] },
    'GET /searches/search-1/results': call => completed([], Number(call.url.searchParams.get('revision'))),
    'GET /tasks/recorded-task': () => ++taskReads === 1 ? first : task('recorded-task', 'succeeded', { search: finished }),
    'PATCH /searches/search-1/options': { status: 503, body: { error: { code: 'dependency_unavailable', message: 'Write rejected before commit' } } },
  });
  await page.goto('/'); await expect.poll(() => taskReads).toBe(1);
  const newer = 'My newer unsent draft  '; await page.locator('#query').fill(newer);
  await page.locator('#posting-languages').click();
  await page.locator('.language-options input[value="fr"]').check();
  await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).toContainText('could not be confirmed');
  await expect.poll(() => taskReads).toBe(2);
  await expect(page.locator('#search-status')).toContainText('Search saved.');
  await expect(page.locator('#query')).toHaveValue(newer);
  expect(calls.filter(call => call.key === 'PATCH /searches/search-1/options')).toHaveLength(1);
  expect(calls.filter(call => call.key === 'POST /searches' || call.key === 'PATCH /searches/search-1')).toHaveLength(0);
  releaseFirst(task('recorded-task', 'succeeded', { search: finished }));
});
test('a committed options revision never revives the invalidated recorded task after a lost acknowledgement', async ({ page }) => {
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  let saved = { ...initial(), draft: { query: 'My submitted refinement', taskId: 'recorded-task', status: 'pending' } };
  const calls = await mockApi(page, {
    'GET /search-options': catalogue, 'GET /searches': () => ({ items: [saved] }),
    'GET /searches/search-1/results': call => completed([], Number(call.url.searchParams.get('revision'))),
    'GET /tasks/recorded-task': () => first,
    'PATCH /searches/search-1/options': call => {
      saved = { ...saved, revision: 2, options: { followedOnly: true, postingLanguages: call.body.postingLanguages }, draft: { ...saved.draft, taskId: null, status: 'interrupted' } };
      return { abort: true };
    },
  });
  await page.goto('/'); await expect.poll(() => calls.filter(call => call.key === 'GET /tasks/recorded-task').length).toBe(1);
  const newer = 'My newer unsent draft  '; await page.locator('#query').fill(newer);
  await page.locator('#posting-languages').click(); await page.locator('.language-options input[value="fr"]').check();
  await page.locator('#apply-posting-languages').click();
  await expect(page.locator('#posting-language-dialog')).toContainText('could not be confirmed');
  await page.locator('#review-posting-languages').click();
  await expect(page.locator('.language-options input[value="fr"]')).toBeChecked();
  await expect(page.locator('#query')).toHaveValue(newer);
  expect(calls.filter(call => call.key === 'GET /tasks/recorded-task')).toHaveLength(1);
  expect(calls.filter(call => call.key === 'POST /searches' || call.key === 'PATCH /searches/search-1')).toHaveLength(0);
  releaseFirst(task('recorded-task', 'succeeded', { search: { ...initial(), revision: 2, query: 'My submitted refinement' } }));
});
