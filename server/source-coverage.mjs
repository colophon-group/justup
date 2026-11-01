// Read one root-owned Jobseek coverage export for a fixed Hiring Wire period.
// Inject it only from trusted runner composition, never from a request.
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const REAL_FILESYSTEM = Object.freeze({ lstat, open });

export const SOURCE_COVERAGE_VERSION = 'jobseek-coverage-v1';
// Current fail-closed caps; measure real exports before considering a higher bound.
export const SOURCE_COVERAGE_LIMITS = Object.freeze({
  artifactBytes: 6 * 1024 * 1024,
  snapshotBytes: 4 * 1024 * 1024
});

function failure(code = 'dependency_unavailable') {
  return Object.assign(new Error('Source coverage history is unavailable.'), { code });
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function periodDate(periodEnd) {
  if (typeof periodEnd !== 'string' || !/^\d{4}-\d\d-\d\dT00:00:00\.000Z$/u.test(periodEnd)) {
    throw failure('invalid_input');
  }
  const date = new Date(periodEnd);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== periodEnd || date.getUTCDay() !== 1) {
    throw failure('invalid_input');
  }
  return periodEnd.slice(0, 10);
}

function protectedMetadata(stat, kind) {
  const wrongType = kind === 'file' ? !stat.isFile() : !stat.isDirectory();
  const unsafeMode = (stat.mode & 0o022) !== 0 || (stat.mode & 0o007) !== 0;
  const unsafeFile = kind === 'file' && (
    stat.nlink !== 1 || stat.size < 1 || stat.size > SOURCE_COVERAGE_LIMITS.artifactBytes
    || (stat.mode & 0o111) !== 0
  );
  if (wrongType || unsafeMode || unsafeFile || stat.uid !== 0) throw failure();
}

async function protectedDirectory(directory, filesystem) {
  const parts = directory.slice(parse(directory).root.length).split(sep).filter(Boolean);
  let current = parse(directory).root;
  async function checkAncestor(path) {
    const stat = await filesystem.lstat(path);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
      throw failure();
    }
  }
  await checkAncestor(current);
  for (const part of parts) {
    current = join(current, part);
    await checkAncestor(current);
  }
  protectedMetadata(await filesystem.lstat(directory), 'directory');
}

function decodeSnapshot(envelope, periodEnd) {
  const validEnvelope = exact(envelope, ['artifactVersion', 'snapshotBytesBase64', 'sha256'])
    && envelope.artifactVersion === 1
    && typeof envelope.sha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(envelope.sha256)
    && typeof envelope.snapshotBytesBase64 === 'string'
    && envelope.snapshotBytesBase64.length <= Math.ceil(SOURCE_COVERAGE_LIMITS.snapshotBytes / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(envelope.snapshotBytesBase64);
  if (!validEnvelope) throw failure();
  const bytes = Buffer.from(envelope.snapshotBytesBase64, 'base64');
  if (bytes.length < 1 || bytes.length > SOURCE_COVERAGE_LIMITS.snapshotBytes
    || bytes.toString('base64') !== envelope.snapshotBytesBase64) {
    throw failure();
  }
  const expected = Buffer.from(envelope.sha256, 'hex');
  const actual = createHash('sha256').update(bytes).digest();
  if (!timingSafeEqual(expected, actual)) throw failure();
  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw failure();
  }
  const validSnapshot = exact(snapshot, [
    'schemaVersion', 'sourceVersion', 'snapshotId', 'asOf', 'generatedAt', 'companies', 'scopes', 'postings'
  ]) && snapshot.schemaVersion === 1 && snapshot.sourceVersion === SOURCE_COVERAGE_VERSION
    && snapshot.asOf === periodEnd && Array.isArray(snapshot.companies)
    && Array.isArray(snapshot.scopes) && Array.isArray(snapshot.postings);
  if (!validSnapshot) throw failure();
  return snapshot;
}

function createReader({ directory } = {}, filesystem) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw failure('invalid_input');
  }
  return Object.freeze({
    authoritative: true,
    version: SOURCE_COVERAGE_VERSION,
    async readSnapshot({ periodEnd, signal } = {}) {
      const date = periodDate(periodEnd);
      if (signal?.aborted) throw failure('task_timeout');
      try {
        await protectedDirectory(directory, filesystem);
        const path = join(directory, `${date}.json`);
        const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          protectedMetadata(await handle.stat(), 'file');
          const chunks = [];
          let total = 0;
          while (true) {
            if (signal?.aborted) throw failure('task_timeout');
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, SOURCE_COVERAGE_LIMITS.artifactBytes + 1 - total));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > SOURCE_COVERAGE_LIMITS.artifactBytes) throw failure();
            chunks.push(chunk.subarray(0, bytesRead));
          }
          const bytes = Buffer.concat(chunks, total);
          const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          return decodeSnapshot(envelope, periodEnd);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error?.code === 'task_timeout') throw error;
        throw failure();
      }
    }
  });
}

export function createSourceCoverageReader(options) {
  return createReader(options, REAL_FILESYSTEM);
}

// Test seam: production always binds the real filesystem above.
export function createSourceCoverageReaderWithFilesystemForTest(options, filesystem) {
  return createReader(options, filesystem);
}
