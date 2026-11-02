// Pure canonical-prefix reconciliation; browser journeys own DOM and motion evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobOrder, reconcileLive } from './liveFeed.ts';
import { decodeLiveSnapshot } from '../../api/liveResults.ts';
const job = (id: string, firstObserved = '2026-11-01T12:00:00Z') => ({ id, firstObserved, title: id, company: { id: 'c', name: 'Company' }, sourceUrl: 'https://example.test/jobs/' + id, locations: [], employmentTypes: [], salary: null });
const event = (ids: string[], retained = ids, complete = true, asOf = '2026-11-02T12:00:00Z') => decodeLiveSnapshot({ schemaVersion: 1, scope: 'active_search', searchId: 's', revision: 1, asOf, reason: 'changed', searches: [{ searchId: 's', revision: 1, items: ids.map(id => job(id)), continuation: { state: 'open', cursor: null }, ai: { status: 'not_required' }, reconciliation: { complete, retainedItemIds: retained } }] }, 's', 1);
test('baseline and prefix expansion never label accepted older rows New or invent retained rows', () => {
  const first = reconcileLive([job('older')], event(['a'], ['a', 'b', 'older']), null)!;
  assert.deepEqual(first.jobs.map(job => job.id), ['a', 'older']);
  assert.deepEqual(first.arrivals, []);
  const expanded = reconcileLive(first.jobs, event(['a', 'b'], ['a', 'b', 'older']), first.baseline)!;
  assert.deepEqual(expanded.arrivals, []);
  assert.ok(expanded.jobs.every(job => !job.isNew));
});
test('later accepted prefix arrivals get one New cohort in timestamp and stable identity order', () => {
  const first = reconcileLive([job('older', '2026-10-31T00:00:00Z')], event(['a']), null)!;
  const next = reconcileLive(first.jobs, event(['z', 'a', 'b']), first.baseline)!;
  assert.deepEqual(next.jobs.map(job => job.id), ['a', 'b', 'z']);
  assert.deepEqual(next.arrivals, ['z', 'b']);
  assert.deepEqual(reconcileLive(next.jobs, event(['z', 'a', 'b']), next.baseline)!.arrivals, []);
});
test('complete recovery removes expired rows throughout pagination; incomplete enumeration preserves unknown rows', () => {
  const jobs = [job('a'), job('old'), job('expired')];
  const incomplete = reconcileLive(jobs, event(['a'], ['a'], false), null)!;
  assert.deepEqual(incomplete.jobs.map(job => job.id), ['a', 'expired', 'old']);
  const complete = reconcileLive(incomplete.jobs, event(['a'], ['a', 'old']), incomplete.baseline)!;
  assert.deepEqual(complete.jobs.map(job => job.id), ['a', 'old']);
  assert.deepEqual(complete.arrivals, []);
});
test('incomplete baseline and ordinary paginated rows cannot become false arrivals', () => {
  const first = reconcileLive([], event(['a'], ['a'], false), null)!;
  const next = reconcileLive([...first.jobs, job('page')], event(['a', 'page', 'unknown']), first.baseline)!;
  assert.ok(next.jobs.every(job => !job.isNew));
  assert.deepEqual(next.arrivals, []);
});
test('authoritative recovery remains valid after a server clock correction', () => {
  const current = reconcileLive([], event(['a']), null);
  const recovered = reconcileLive(current.jobs, event(['replacement'], ['replacement'], true, '2026-11-01T12:00:00Z'), current.baseline);
  assert.deepEqual(recovered.jobs.map(job => job.id), ['replacement']);
});

test('first-observed order retains submillisecond precision and normalizes UTC spellings', () => {
  const items = [job('a', '2026-11-01T12:00:00.000000001Z'), job('z', '2026-11-01T12:00:00.000000002+00:00'), job('same-b', '2026-11-01T12:00:00Z'), job('same-a', '2026-11-01T12:00:00.000Z')];
  assert.deepEqual(items.sort(jobOrder).map(job => job.id), ['z', 'a', 'same-a', 'same-b']);
});
