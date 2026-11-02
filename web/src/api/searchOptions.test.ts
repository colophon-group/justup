// Posting-language contracts retain source identifiers and fence owner-bound mutations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSearch, decodeSearchOptionsCatalogue } from './decode.ts';
import { ApiClient } from './client.ts';
import type { Session } from './types.ts';
const catalogue = { postingLanguages: [{ id: 'de-CH', name: 'Swiss High German' }, { id: 'fr', name: 'French' }], emptySelection: 'any', selectionOperator: 'or', queryCombination: 'intersection' };
const search = { id: 'search', revision: 2, query: 'Unchanged text', title: 'Jobs', status: 'ready', options: { followedOnly: true, postingLanguages: ['de-CH'] } };
test('catalogue validates explicit semantics and real identifiers without a language count cap', () => {
  assert.deepEqual(decodeSearchOptionsCatalogue(catalogue), catalogue);
  const many = Array.from({ length: 800 }, (_, i) => ({ id: `en-x-${String(i).padStart(5, '0')}`, name: `Language ${i}` }));
  assert.equal(decodeSearchOptionsCatalogue({ ...catalogue, postingLanguages: many }).postingLanguages.length, 800);
  for (const value of [
    { ...catalogue, emptySelection: 'none' }, { ...catalogue, selectionOperator: 'and' },
    { ...catalogue, queryCombination: 'union' }, { ...catalogue, postingLanguages: [{ id: 'invalid_tag', name: 'Invalid' }] },
    { ...catalogue, postingLanguages: [catalogue.postingLanguages[0], catalogue.postingLanguages[0]] },
  ]) assert.throws(() => decodeSearchOptionsCatalogue(value));
  assert.deepEqual(decodeSearch(search).options, search.options);
  assert.equal(decodeSearch({ ...search, options: undefined }).options, undefined);
  assert.throws(() => decodeSearch({ ...search, options: null }));
});
test('visitor/account paths send options and preserve revision/follow scope with same-origin transport', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new ApiClient({ fetch: async (url, init) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return Response.json(String(url).endsWith('search-options') ? catalogue : { search }); } });
  client.setSession({ user: { id: 'owner', username: 'reader' }, csrfToken: 'synthetic' } as Session);
  for (const scope of ['visitor', 'account'] as const) {
    const prefix = scope === 'visitor' ? '/api/v1/visitor' : '/api/v1';
    await client.getSearchOptions(undefined, scope);
    assert.equal(calls.at(-1)?.url, `${prefix}/search-options`);
    await client.updateSearchOptions('search', { ...search.options, expectedRevision: 1 }, undefined, scope);
    assert.equal(calls.at(-1)?.url, `${prefix}/searches/search/options`);
    assert.equal(calls.at(-1)?.init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { ...search.options, expectedRevision: 1 });
    assert.equal(calls.at(-1)?.init?.credentials, 'same-origin');
    await client.createSearch({ query: search.query, requestKey: 'new', options: search.options }, undefined, scope);
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)).options, search.options);
  }
});
test('a language-save response from a previous owner cannot reach browser state', async () => {
  let release!: (value: Response) => void;
  const client = new ApiClient({ fetch: () => new Promise(resolve => { release = resolve; }) });
  client.setSession({ user: { id: 'first' }, csrfToken: 'synthetic' } as Session);
  const pending = client.updateSearchOptions('search', { ...search.options, expectedRevision: 1 });
  client.setSession({ user: { id: 'second' }, csrfToken: 'synthetic2' } as Session);
  release(Response.json({ search }));
  await assert.rejects(pending, { name: 'AbortError' });
});
