// Follow protocol validates canonical snapshots and rejects a previous session's replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from './client.ts';
import { decodeFollows } from './decode.ts';
import type { Session } from './types.ts';
const snapshot = { accountId: 'first', revision: 1, items: [{ companyId: 'company', followedAt: '2026-11-02T12:00:00.000Z' }], invalidatedSearchIds: ['search'] };
test('follow snapshots validate owner, revision, unique identities and timestamps', () => {
  assert.deepEqual(decodeFollows(snapshot), snapshot);
  for (const patch of [{ accountId: '' }, { revision: -1 }, { revision: 1.5 }, { items: [snapshot.items[0], snapshot.items[0]] }, { items: [{ companyId: 'company', followedAt: 'yesterday' }] }, { invalidatedSearchIds: ['search', 'search'] }]) assert.throws(() => decodeFollows({ ...snapshot, ...patch }));
});
test('follow transport uses captured revisions and rejects late replies after sign-out or account switches', async () => {
  for (const next of [null, { user: { id: 'second' }, csrfToken: 'second' } as Session]) {
    let release!: (value: Response) => void;
    let sent!: RequestInit;
    const client = new ApiClient({ fetch: async (url, init) => { assert.equal(url, '/api/v1/follows/company'); sent = init!; return new Promise(resolve => { release = resolve; }); } });
    client.setSession({ user: { id: 'first' }, csrfToken: 'first' } as Session);
    const pending = client.updateFollow('company', true, 0);
    assert.deepEqual(JSON.parse(String(sent.body)), { followed: true, expectedRevision: 0 });
    assert.equal(sent.credentials, 'same-origin');
    client.setSession(next); release(Response.json(snapshot));
    await assert.rejects(pending, { name: 'AbortError' });
  }
});
