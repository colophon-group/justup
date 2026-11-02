import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMetadata } from './metadata.ts';
const origin = 'https://justup.example';
const ready = { outcome: 'ready' } as const;
test('public metadata resets company descriptions and language links across routes using public facts only', () => {
  const company = publicMetadata({ page: 'company', id: 'public/id', locale: 'fr' }, { ...ready, company: { id: 'public/id', name: 'Public company', description: 'Reported description.' } }, origin, '/ignored');
  assert.match(company.title, /Public company/); assert.match(company.description, /Reported description/);
  assert.equal(company.canonical, origin + '/fr/companies/public%2Fid');
  assert.equal(company.alternates.length, 5); assert.equal(company.noindex, false);
  const catalogue = publicMetadata({ page: 'companies', locale: 'en' }, ready, origin, '/companies');
  assert.doesNotMatch(catalogue.description, /Public company|Reported description/);
  assert.ok(catalogue.alternates.every(item => item.href.endsWith('/companies')));
  const landing = publicMetadata({ page: 'jobs', locale: 'en' }, ready, origin, '/');
  assert.match(landing.description, /14 days/); assert.equal(landing.canonical, origin + '/');
});
test('private surfaces and unsuccessful company loads cannot inherit successful indexing or stale company facts', () => {
  for (const outcome of ['pending', 'not-found', 'unavailable'] as const) {
    const metadata = publicMetadata({ page: 'company', id: 'missing', locale: 'en' }, { outcome }, origin, '/companies/missing');
    assert.equal(metadata.noindex, true); assert.deepEqual(metadata.alternates, []);
    assert.doesNotMatch(metadata.title + metadata.description, /Public company/);
  }
  for (const page of ['jobs', 'companies', 'company', 'request'] as const) {
    const metadata = publicMetadata({ page, id: 'public', locale: 'en' }, ready, origin, '/', true);
    assert.equal(metadata.noindex, true); assert.ok(!metadata.canonical.includes('?') && !metadata.canonical.includes('#'));
  }
  assert.equal(publicMetadata({ page: 'invalid', locale: 'en' }, ready, origin, '/missing').noindex, true);
});
test('account/browser render language never rewrites an unprefixed canonical URL', () => {
  const metadata = publicMetadata({ page: 'companies', locale: 'en' }, ready, origin, '/companies', false, 'de');
  assert.match(metadata.title, /Firmenkatalog/); assert.equal(metadata.canonical, origin + '/companies');
});
