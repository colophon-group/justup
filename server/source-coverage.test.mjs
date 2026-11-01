import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceCoverageReader, SOURCE_COVERAGE_VERSION, SOURCE_COVERAGE_LIMITS } from './source-coverage.mjs';

const PERIOD_END = '2026-11-02T00:00:00.000Z';

function snapshot() {
  return {
    schemaVersion: 1, sourceVersion: SOURCE_COVERAGE_VERSION, snapshotId: 'jobseek-coverage-2026-11-02',
    asOf: PERIOD_END, generatedAt: '2026-11-02T01:00:00.000Z',
    companies: [{ id: 'company-a', name: 'Café & Co', url: 'https://example.com/' }],
    scopes: [{ id: 'board-a', companyId: 'company-a', revision: 'revision-a', trackedSince: '2026-10-01T00:00:00.000Z',
      lastVerifiedAt: '2026-11-02T00:30:00.000Z', coverage: [{ start: '2026-10-19T00:00:00.000Z', end: PERIOD_END, state: 'complete' }] }],
    postings: [{ id: 'posting-a', scopeId: 'board-a', firstObserved: '2026-10-29T00:00:00.000Z' }]
  };
}

function artifact(raw) {
  return {
    artifactVersion: 1,
    snapshotBytesBase64: raw.toString('base64'),
    sha256: createHash('sha256').update(raw).digest('hex')
  };
}

async function directory(t) {
  const path = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.source-coverage-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function publish(path, value, mode = 0o600) {
  const file = join(path, '2026-11-02.json');
  await writeFile(file, JSON.stringify(value), { mode });
  await chmod(file, mode);
  return file;
}

test('reads exact Jobseek bytes with Unicode and ampersands without reserializing the digest', async t => {
  const path = await directory(t);
  const raw = Buffer.from(JSON.stringify(snapshot()).replace('Café & Co', 'Caf\\u00e9 & Co'), 'utf8');
  await publish(path, artifact(raw));
  const source = createSourceCoverageReader({ directory: path });
  assert.equal(source.authoritative, true);
  assert.equal(source.version, SOURCE_COVERAGE_VERSION);
  assert.deepEqual(await source.readSnapshot({ periodEnd: PERIOD_END }), snapshot());
});

test('preserves unknown scope evidence without inventing a verification timestamp', async t => {
  const path = await directory(t);
  const unknown = snapshot();
  unknown.scopes[0].lastVerifiedAt = null;
  unknown.scopes[0].coverage = [{ start: '2026-10-19T00:00:00.000Z', end: PERIOD_END, state: 'unknown' }];
  await publish(path, artifact(Buffer.from(JSON.stringify(unknown))));
  const actual = await createSourceCoverageReader({ directory: path }).readSnapshot({ periodEnd: PERIOD_END });
  assert.deepEqual(actual, unknown);
});

test('rejects changed bytes, wrong period, wrong source version and invalid transport data', async t => {
  const path = await directory(t);
  const source = createSourceCoverageReader({ directory: path });
  const original = Buffer.from(JSON.stringify(snapshot()));
  const cases = [
    { ...artifact(original), sha256: '0'.repeat(64) },
    artifact(Buffer.from(JSON.stringify({ ...snapshot(), asOf: '2026-11-09T00:00:00.000Z' }))),
    artifact(Buffer.from(JSON.stringify({ ...snapshot(), sourceVersion: 'unreviewed-v2' }))),
    { ...artifact(original), snapshotBytesBase64: '@@@' },
    { ...artifact(original), extra: true }
  ];
  for (const value of cases) {
    await publish(path, value);
    await assert.rejects(source.readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
  }
  await assert.rejects(source.readSnapshot({ periodEnd: '2026-11-03T00:00:00.000Z' }), { code: 'invalid_input' });
});

test('rejects missing, symlinked or publicly accessible evidence', async t => {
  const path = await directory(t);
  const source = createSourceCoverageReader({ directory: path });
  await assert.rejects(source.readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
  const real = join(path, 'real.json');
  await writeFile(real, JSON.stringify(artifact(Buffer.from(JSON.stringify(snapshot())))), { mode: 0o600 });
  await symlink(real, join(path, '2026-11-02.json'));
  await assert.rejects(source.readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
  await rm(join(path, '2026-11-02.json'));
  await publish(path, artifact(Buffer.from(JSON.stringify(snapshot()))), 0o644);
  await assert.rejects(source.readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
  await chmod(join(path, '2026-11-02.json'), 0o600);
  await chmod(path, 0o770);
  await assert.rejects(source.readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
});

test('rejects a protected-looking directory behind a symlinked or writable ancestor', async t => {
  const root = await directory(t);
  const target = join(root, 'target');
  const nested = join(target, 'nested');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await publish(nested, artifact(Buffer.from(JSON.stringify(snapshot()))));

  const link = join(root, 'redirect');
  await symlink(target, link);
  await assert.rejects(createSourceCoverageReader({ directory: join(link, 'nested') }).readSnapshot({ periodEnd: PERIOD_END }), {
    code: 'dependency_unavailable'
  });

  await chmod(target, 0o770);
  await assert.rejects(createSourceCoverageReader({ directory: nested }).readSnapshot({ periodEnd: PERIOD_END }), {
    code: 'dependency_unavailable'
  });
});

test('rejects decoded evidence above the consumer persistence ceiling', async t => {
  const path = await directory(t);
  const oversized = Buffer.alloc(SOURCE_COVERAGE_LIMITS.snapshotBytes + 1, 0x20);
  await publish(path, artifact(oversized));
  await assert.rejects(createSourceCoverageReader({ directory: path }).readSnapshot({ periodEnd: PERIOD_END }), { code: 'dependency_unavailable' });
});
