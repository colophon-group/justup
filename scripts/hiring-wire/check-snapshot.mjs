// Local read-only projection check. Output is limited to counts and an evidence
// hash; a schema-valid input does not authorize or establish source continuity.
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileWireSnapshot, wireError } from '../../server/hiring-wire-facts.mjs';
import { decodeSourceCoverageArtifact, SOURCE_COVERAGE_LIMITS } from '../../server/source-coverage.mjs';

function readBounded(fd, limit) {
  const bytes = Buffer.allocUnsafe(limit + 1);
  let size = 0;
  while (size <= limit) {
    const read = readSync(fd, bytes, size, bytes.length - size, null);
    if (!read) break;
    size += read;
  }
  if (!size || size > limit) throw wireError('invalid_output');
  return bytes.subarray(0, size);
}

function readProjection(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > SOURCE_COVERAGE_LIMITS.snapshotBytes) {
      throw wireError('invalid_output');
    }
    const bytes = readBounded(fd, SOURCE_COVERAGE_LIMITS.snapshotBytes);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || ['size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) {
      throw wireError('invalid_output');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    closeSync(fd);
  }
}

export function checkSnapshot({ args = process.argv.slice(2), now = Date.now, inputFd = 0 } = {}) {
  let periodEnd, snapshot;
  if (args.length === 5 && args[0] === '--artifact' && args[1] === '--source-version' && args[3] === '--period') {
    periodEnd = args[4];
    const bytes = readBounded(inputFd, SOURCE_COVERAGE_LIMITS.artifactBytes);
    snapshot = decodeSourceCoverageArtifact(bytes, { periodEnd, sourceVersion: args[2] });
  } else if (args.length === 3 && isAbsolute(args[0]) && args[1] === '--period') {
    periodEnd = args[2];
    snapshot = readProjection(args[0]);
  } else {
    throw wireError('invalid_input');
  }
  const compiled = compileWireSnapshot(snapshot, { periodEnd, now: now() });
  return {
    periodEnd: compiled.period.end,
    snapshotSha256: compiled.snapshotSha256,
    comparableCompanies: compiled.facts.length,
    suppressedScopes: compiled.suppressed.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(checkSnapshot())}\n`);
  } catch {
    process.stderr.write('Hiring Wire history could not be verified.\n');
    process.exitCode = 1;
  }
}
