import test from 'node:test';
import assert from 'node:assert/strict';
import { safePublicCompanyURL } from './publicCompanyUrls.ts';
import { decodeCompany } from './decode.ts';
test('company metadata permits public HTTPS paths and queries without inventing career-link approval', () => {
  const url = 'https://boards.greenhouse.io/public/jobs?location=remote&team=R%26D';
  assert.equal(safePublicCompanyURL(url), url);
  const company = decodeCompany({ id: 'public', name: 'Public', websiteUrl: url, logoUrl: 'https://cdn.example.com/brand.svg?v=2',
    sources: [{ url }], evidenceUrls: [url, 'https://127.0.0.1/private'], domain: 'internal.lan' });
  assert.equal(company.websiteUrl, url); assert.equal(company.logoUrl, 'https://cdn.example.com/brand.svg?v=2');
  assert.deepEqual(company.evidenceUrls, [url]); assert.equal(Object.hasOwn(company, 'sources'), false); assert.equal(company.domain, undefined);
});
test('browser-local and malformed company metadata never becomes an external URL', () => {
  for (const value of ['http://example.com/jobs', 'https://127.0.0.1/jobs', 'https://[::1]/', 'https://2130706433/', 'https://0x7f000001/',
    'https://192.168.0.1/', 'https://localhost/', 'https://foo.localhost/', 'https://internal.lan/', 'https://foo.test/', 'https://example.com:5432/',
    'https://user:pass@example.com/', 'https://example.com\\@127.0.0.1/', 'javascript:alert(1)', 'data:image/svg+xml,x']) assert.equal(safePublicCompanyURL(value), null, value);
});
