import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompanyCataloguePage } from '../api/decode.ts';
test('public company continuation is explicit, bounded and cannot repeat within a page', () => {
  const company = { id: 'public', name: 'Public company' };
  assert.deepEqual(decodeCompanyCataloguePage({ items: [company], nextCursor: null }), { items: [company], nextCursor: null });
  assert.equal(decodeCompanyCataloguePage({ items: [company], nextCursor: 'signed-public-cursor' }).nextCursor, 'signed-public-cursor');
  for (const value of [{ items: [] }, { items: [], nextCursor: 'cursor' }, { items: [company, company], nextCursor: null }, { items: Array.from({ length: 51 }, (_, i) => ({ id: String(i), name: 'Company' })), nextCursor: null }]) assert.throws(() => decodeCompanyCataloguePage(value));
});
