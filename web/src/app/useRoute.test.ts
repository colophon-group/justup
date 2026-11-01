import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoute, pageHref, explicitRouteLocale } from './useRoute.ts';
test('public paths identify locale and company without reading browser or private state', () => {
  assert.deepEqual(readRoute('/'), { page: 'jobs', locale: 'en' });
  assert.deepEqual(readRoute('/de/companies'), { page: 'companies', locale: 'de' });
  assert.deepEqual(readRoute('/fr/companies/a%20b'), { page: 'company', id: 'a b', locale: 'fr' });
  assert.deepEqual(readRoute('/it/', '#request'), { page: 'request', locale: 'it' });
  for (const pathname of ['/companies/a/b', '/companies/%ZZ', '/companies/a%2fb', '/companies/a%5cb', '/private/account', '/searches/private']) assert.equal(readRoute(pathname).page, 'invalid');
  assert.equal(pageHref('company', 'es', 'public/name'), '/es/companies/public%2Fname');
  assert.equal(pageHref('companies'), '/companies');
});

test('only explicit non-English route prefixes override account and browser preferences', () => {
  for (const path of ['/', '/companies', '/companies/public', '/en/companies']) assert.equal(explicitRouteLocale(path), undefined);
  for (const locale of ['de', 'fr', 'it', 'es'] as const) assert.equal(explicitRouteLocale(`/${locale}/companies`), locale);
});
