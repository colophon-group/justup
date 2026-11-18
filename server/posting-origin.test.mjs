import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createFeed } from './feed.mjs';
import { DAY_MS, openStore } from './store.mjs';
import { ORIGIN_POLICY_VERSION } from './posting-origin.mjs';

const at = Date.now() - 1_000;
const iso = time => new Date(time).toISOString();
const manifestSha256 = 'a'.repeat(64);
const account = { account: { id: 'test-account' }, access: { fullAccess: true } };

function posting(id, age = 3) {
  return {
    id, companyId: `company-${id}`, companyName: `Example ${id}`, sourceUrl: `https://source.example/${id}`,
    title: `Job ${id}`, firstObserved: iso(at - age * DAY_MS), active: true, reserved: false, hasContent: true,
    locales: ['en'], locations: [], employmentTypes: [],
    evidence: { source: 'jobseek_public', normalizationVersion: 1, metadataFetchedAt: iso(at),
      textSha256: null, bodyBytes: 0, truncated: false },
  };
}

function snapshot(jobs) {
  return { schemaVersion: 1, snapshotAt: iso(at), verifiedAt: iso(at), jobs, selection: {
    source: 'jobseek_feed_v1', limitedCoverage: false, sourceScopeRowCount: jobs.length,
    feed: { complete: true, manifestSha256, fullSnapshotAt: iso(at), scope: { kind: 'all_eligible' } },
  } };
}

function review(snapshot, verdicts = {}) {
  return { schemaVersion: 1, policyVersion: ORIGIN_POLICY_VERSION, manifestSha256,
    snapshotSha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), reviewedAt: iso(at),
    postings: snapshot.jobs.map(({ id, companyId, sourceUrl }) => {
      const verdict = verdicts[id] ?? 'direct_employer';
      return { id, companyId, sourceUrl, verdict, evidenceUrl: verdict === 'unknown' ? null : 'https://review.example/publisher' };
    }) };
}

test('reviewed import excludes agency, repost and unknown listings from every access tier', t => {
  const store = openStore(); t.after(() => store.close());
  let clock = at;
  const feed = createFeed({ db: store.db, now: () => clock });
  const candidate = snapshot([posting('direct'), posting('agency', 1), posting('repost'), posting('unclear')]);
  const verdicts = { agency: 'recruitment_agency', repost: 'repost', unclear: 'unknown' };
  store.importSnapshot(candidate);
  assert.deepEqual(feed.restrictedLatestJobs().map(job => job.id), ['agency']);

  store.importSnapshot(candidate, { originReview: review(candidate, verdicts) });
  assert.deepEqual(feed.list().items.map(job => job.id), ['direct']);
  assert.deepEqual(feed.eligibleJobs({ viewer: account }).map(job => job.id), ['direct']);
  assert.deepEqual(feed.restrictedLatestJobs(), []);
  assert.equal(feed.coverage().postingOrigin, 'reviewed_with_unknowns');
  assert.doesNotMatch(JSON.stringify(feed.list()), /review\.example|snapshotSha256/u);
  assert.throws(() => store.importSnapshot(candidate), { code: 'origin_review_required' });
  assert.deepEqual(feed.list().items.map(job => job.id), ['direct']);
  assert.equal(store.db.prepare("SELECT active, closed_observed_at FROM justup_jobs WHERE id='agency'").get().closed_observed_at, null);

  clock += DAY_MS;
  assert.equal(feed.coverage().postingOrigin, undefined);
  assert.equal(feed.list().continuation.state, 'paused');
});

test('posting review requires exact identity, evidence for each verdict and the complete source manifest', t => {
  const store = openStore(); t.after(() => store.close());
  const candidate = snapshot([posting('a'), posting('b')]);
  for (const mutate of [
    value => value.postings.pop(),
    value => { value.postings[1] = value.postings[0]; },
    value => { value.postings[0].companyId = 'other'; },
    value => { value.postings[0].sourceUrl = 'https://source.example/other'; },
    value => { value.postings[0].evidenceUrl = 'http://review.example/other'; },
    value => { value.postings[0].verdict = 'unknown'; },
    value => { value.manifestSha256 = 'b'.repeat(64); },
    value => { value.reviewedAt = iso(at - 1); },
  ]) {
    const invalid = review(candidate); mutate(invalid);
    assert.throws(() => store.importSnapshot(candidate, { originReview: invalid }), { code: 'invalid_origin_review' });
    assert.equal(store.generation(), null);
  }
  const proof = review(candidate, { b: 'repost' });
  store.importSnapshot(candidate, { originReview: proof });
  const feed = createFeed({ db: store.db, now: () => at });
  assert.equal(feed.coverage().postingOrigin, 'reviewed_direct_only');
  assert.deepEqual(feed.eligibleJobs().map(job => job.id), ['a']);
  assert.throws(() => store.importSnapshot({ ...candidate, selection: { ...candidate.selection, postingOriginReview: proof } }), { code: 'invalid_import' });
});

test('a newer origin verdict can correct a prior review without changing source lifecycle', t => {
  const store = openStore(); t.after(() => store.close());
  const feed = createFeed({ db: store.db, now: () => at + 100 });
  const candidate = snapshot([posting('a')]);
  const second = { ...review(candidate, { a: 'recruitment_agency' }), reviewedAt: iso(at + 10) };
  const first = review(candidate);
  const admitted = () => feed.eligibleJobs().map(job => job.id);
  store.importSnapshot(candidate, { originReview: first });
  assert.deepEqual(admitted(), ['a']);
  const generation = store.importSnapshot(candidate, { originReview: second }).generation;
  assert.deepEqual(admitted(), []);
  assert.throws(() => store.importSnapshot(candidate, { originReview: first }), { code: 'stale_origin_review' });
  assert.throws(() => store.importSnapshot(candidate, { originReview: { ...first, reviewedAt: iso(at + 10) } }), { code: 'stale_origin_review' });
  assert.equal(store.importSnapshot(candidate, { originReview: second }).generation, generation);
  assert.deepEqual(admitted(), []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM justup_feed_omissions').get().n, 0);
  store.importSnapshot(candidate, { originReview: { ...first, reviewedAt: iso(at + 20) } });
  assert.deepEqual(admitted(), ['a']);
});

test('prior source membership still fences an exact omission of a policy-excluded posting', t => {
  const store = openStore(); t.after(() => store.close());
  const feed = createFeed({ db: store.db, now: () => at + 100 });
  const source = posting('a');
  const accepted = snapshot([source]);
  store.importSnapshot(accepted, { originReview: review(accepted, { a: 'repost' }) });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM justup_jobs').get().n, 0);

  const removed = { ...snapshot([]), snapshotAt: iso(at + 10), verifiedAt: iso(at + 10) };
  store.importSnapshot(removed, { originReview: { ...review(removed), reviewedAt: iso(at + 10) } });
  assert.equal(store.db.prepare("SELECT omitted_at FROM justup_feed_omissions WHERE id='a'").get().omitted_at, at + 10);
  const stale = { ...accepted, snapshotAt: iso(at + 20), verifiedAt: iso(at + 20) };
  store.importSnapshot(stale, { originReview: { ...review(stale), reviewedAt: iso(at + 20) } });
  assert.deepEqual(feed.eligibleJobs(), []);
  const refreshed = { ...stale, snapshotAt: iso(at + 30), verifiedAt: iso(at + 30),
    jobs: [{ ...source, evidence: { ...source.evidence, metadataFetchedAt: iso(at + 30) } }] };
  store.importSnapshot(refreshed, { originReview: { ...review(refreshed), reviewedAt: iso(at + 30) } });
  assert.deepEqual(feed.eligibleJobs().map(job => job.id), ['a']);
});

test('the operator import binds the review to exact snapshot bytes and a private regular file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-origin-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'state.sqlite'), candidatePath = join(dir, 'snapshot.json'), reviewPath = join(dir, 'review.json');
  const candidate = snapshot([posting('a')]), proof = review(candidate);
  const script = fileURLToPath(new URL('./main.mjs', import.meta.url));
  const run = path => spawnSync(process.execPath, [script, '--import', candidatePath, '--origin-review', path], {
    env: { PATH: process.env.PATH, JUSTUP_DB_PATH: dbPath }, encoding: 'utf8', timeout: 10_000,
  });
  writeFileSync(candidatePath, JSON.stringify(candidate) + '\n');
  writeFileSync(reviewPath, JSON.stringify(proof), { mode: 0o600 });
  assert.match(run(reviewPath).stderr, /different import file/u);
  writeFileSync(candidatePath, JSON.stringify(candidate));
  const alias = join(dir, 'review-link.json'); symlinkSync(reviewPath, alias);
  assert.notEqual(run(alias).status, 0);
  chmodSync(reviewPath, 0o644); assert.match(run(reviewPath).stderr, /private posting origin review/u);
  chmodSync(reviewPath, 0o600);
  const accepted = run(reviewPath); assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).imported, 1);
  const store = openStore(dbPath); t.after(() => store.close());
  assert.equal(createFeed({ db: store.db }).coverage().postingOrigin, 'reviewed_direct_only');
  const legacy = new DatabaseSync(dbPath); t.after(() => legacy.close());
  assert.throws(() => legacy.prepare("INSERT INTO justup_imports VALUES ('unreviewed',1,1,'{}',0,0)").run(), /no such function/u);
  assert.equal(legacy.prepare('SELECT count(*) AS n FROM justup_imports').get().n, 1);
});

test('a descriptor-backed review must match the separately approved snapshot before any database write', t => {
  const dir = mkdtempSync(join(tmpdir(), 'justup-origin-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'state.sqlite'), candidatePath = join(dir, 'snapshot.json'), reviewPath = join(dir, 'review.json');
  const approved = review(snapshot([posting('approved')]));
  const replaced = snapshot([posting('replacement')]), paired = review(replaced);
  const raw = JSON.stringify(paired), digest = createHash('sha256').update(raw).digest('hex');
  writeFileSync(candidatePath, JSON.stringify(replaced));
  writeFileSync(reviewPath, raw, { mode: 0o600 });
  const fd = openSync(reviewPath, 'r');
  try {
    const script = fileURLToPath(new URL('./main.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--import', candidatePath, '--origin-review-stdin', digest, approved.snapshotSha256], {
      env: { PATH: process.env.PATH, JUSTUP_DB_PATH: dbPath }, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Job import differs from its approval/u);
    assert.equal(existsSync(dbPath), false);
  } finally { closeSync(fd); }
});
