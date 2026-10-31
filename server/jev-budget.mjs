// Anonymous cumulative JEV reservations, separate from preview SQLite/backups.
// Runtime only appends to an operator-prepared approved ledger; it never resets it.
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync,
  writeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, basename, isAbsolute, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const JEV_BUDGET_RESOURCE = 'https://github.com/colophon-group/justup/issues/49';
export const JEV_BUDGET_SLUG = 'demo-jev-evaluation-budget';
export const JEV_CUMULATIVE_CAP_NANO = 500_000_000;
export const JEV_ATTEMPT_INPUT_TOKENS = 64_000;
const MAX_BYTES = 4 * 1024 * 1024, MAX_LINES = 10_000;
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const exact = (a, b) => a && typeof a === 'object' && !Array.isArray(a)
  && Object.keys(a).sort().join(',') === [...b].sort().join(',');
const within = (parent, path) => { const r = relative(parent, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const fail = (code = 'budget_unavailable') => Object.assign(new Error('Cumulative provider budget is unavailable.'), { code });

// This pure template is deliberately UNAPPROVED. A protected operator must bind
// real human approval and confirmed account pricing before preparing the file.
export function unapprovedJevBudgetTemplate({ model = 'jev-1.14.0' } = {}) {
  return { schemaVersion: 1, kind: 'approval', ledgerId: randomUUID(), resourceId: JEV_BUDGET_RESOURCE, resourceSlug: JEV_BUDGET_SLUG,
    approvalId: null, capNanodollars: JEV_CUMULATIVE_CAP_NANO, model, pricingVersion: null,
    inputNanodollarsPerToken: null, outputNanodollarsPerToken: null, maxInputTokensPerAttempt: JEV_ATTEMPT_INPUT_TOKENS };
}

export function createJevBudget({ config, model, pricing, databasePath = null } = {}) {
  let expected = null, path = null, exclusions = [];
  try {
    const a = config?.approval;
    if (a?.approved !== true || a.resourceId !== JEV_BUDGET_RESOURCE || a.resourceSlug !== JEV_BUDGET_SLUG
        || !/^(?:https:\/\/github\.com\/colophon-group\/justup\/issues\/49#issuecomment-\d{1,20}|operator-(?:user-turn|approval):[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.test(a.approvalId ?? '')
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(a.ledgerId ?? '')
        || !integer(a.capNanodollars) || a.capNanodollars < 1 || a.capNanodollars > JEV_CUMULATIVE_CAP_NANO
        || typeof config.path !== 'string' || !isAbsolute(config.path) || resolve(config.path) !== config.path
        || !/^[A-Za-z0-9_.-]{1,80}$/u.test(basename(config.path))
        || !Array.isArray(config.excludedDirectories) || config.excludedDirectories.length < 1 || config.excludedDirectories.length > 8
        || config.excludedDirectories.some((p) => typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p)
        || pricing?.confirmed !== true || pricing.model !== model || typeof pricing.version !== 'string' || !pricing.version || pricing.version.length > 128
        || !integer(pricing.inputNanodollarsPerToken) || pricing.inputNanodollarsPerToken < 1 || pricing.outputNanodollarsPerToken !== 0) throw fail();
    expected = { schemaVersion: 1, kind: 'approval', ledgerId: a.ledgerId, resourceId: a.resourceId, resourceSlug: JEV_BUDGET_SLUG,
      approvalId: a.approvalId, capNanodollars: a.capNanodollars, model, pricingVersion: pricing.version,
      inputNanodollarsPerToken: pricing.inputNanodollarsPerToken, outputNanodollarsPerToken: 0,
      maxInputTokensPerAttempt: JEV_ATTEMPT_INPUT_TOKENS };
    path = config.path; exclusions = config.excludedDirectories;
  } catch { /* Missing/unapproved configuration stays disabled, with no file creation. */ }
  const cost = expected ? expected.inputNanodollarsPerToken * JEV_ATTEMPT_INPUT_TOKENS : null;
  function secure(stat, mode, directory = false) {
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid()
        || (stat.mode & 0o7777) !== mode || (!directory && stat.nlink !== 1)) throw fail();
  }
  function openLedger() {
    if (!expected || !Number.isSafeInteger(cost) || cost > expected.capNanodollars) throw fail();
    const parent = dirname(path);
    if (realpathSync(parent) !== parent || exclusions.some((p) => realpathSync(p) !== p || within(p, path))
        || (databasePath && databasePath !== ':memory:' && (resolve(databasePath) === path || dirname(resolve(databasePath)) === parent))) throw fail();
    secure(lstatSync(parent), 0o700, true);
    const original = lstatSync(path); secure(original, 0o600);
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); secure(opened, 0o600);
      if (original.ino !== opened.ino || original.dev !== opened.dev || opened.size < 1 || opened.size > MAX_BYTES) throw fail();
      return fd;
    } catch (e) { closeSync(fd); throw e; }
  }
  function read(fd) {
    const data = readFileSync(fd);
    if (data.length > MAX_BYTES || !data.length || data.at(-1) !== 10) throw fail();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw fail(); }
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > MAX_LINES || lines.some((l) => !l || l.length > 4096)) throw fail();
    let previous = null, total = 0, sequence = 0, halted = false;
    for (const [index, line] of lines.entries()) {
      let row; try { row = JSON.parse(line); } catch { throw fail(); }
      if (JSON.stringify(row) !== line) throw fail(); // duplicates/partial/noncanonical lines fail closed
      if (index === 0) {
        if (!exact(row, Object.keys(expected)) || Object.keys(expected).some((k) => row[k] !== expected[k])) throw fail();
      } else {
        if (halted || !exact(row, ['kind', 'sequence', 'previousHash', 'costNanodollars', 'reservedNanodollars', 'hash'])
            || row.sequence !== ++sequence || row.previousHash !== previous
            || !['reserve', 'halt'].includes(row.kind) || !integer(row.costNanodollars)
            || row.costNanodollars !== (row.kind === 'reserve' ? cost : 0)
            || row.reservedNanodollars !== total + row.costNanodollars || row.reservedNanodollars > expected.capNanodollars) throw fail();
        const { hash: digest, ...unsigned } = row;
        if (digest !== hash(unsigned)) throw fail();
        total = row.reservedNanodollars; halted = row.kind === 'halt';
      }
      previous = hash(row);
    }
    return { total, sequence, previous, halted, size: data.length };
  }
  function append(kind) {
    let fd, lock, directory, retainLock = true;
    try {
      fd = openLedger();
      directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      secure(fstatSync(directory), 0o700, true);
      try { lock = openSync(`${path}.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { throw fail('budget_locked'); }
      secure(fstatSync(lock), 0o600); fsyncSync(lock); fsyncSync(directory);
      const state = read(fd);
      if (state.halted) { retainLock = false; throw fail(); }
      if (kind === 'reserve' && state.total + cost > expected.capNanodollars) { retainLock = false; throw fail('budget_exhausted'); }
      const unsigned = { kind, sequence: state.sequence + 1, previousHash: state.previous,
        costNanodollars: kind === 'reserve' ? cost : 0,
        reservedNanodollars: state.total + (kind === 'reserve' ? cost : 0) };
      const line = Buffer.from(`${JSON.stringify({ ...unsigned, hash: hash(unsigned) })}\n`);
      if (state.size + line.length > MAX_BYTES || state.sequence + 2 > MAX_LINES) throw fail();
      let written = 0;
      while (written < line.length) { const n = writeSync(fd, line, written, line.length - written); if (n < 1) throw fail(); written += n; }
      fsyncSync(fd);
      // A crash anywhere before this point retains the exclusive lock. No runtime
      // path removes a retained lock or refunds this irreversible reservation.
      retainLock = false;
      return { sequence: unsigned.sequence, costNanodollars: unsigned.costNanodollars, reservedNanodollars: unsigned.reservedNanodollars };
    } catch (e) { throw fail(['budget_exhausted', 'budget_locked'].includes(e.code) ? e.code : 'budget_unavailable'); }
    finally {
      try {
        if (lock != null && !retainLock) {
          const actual = lstatSync(`${path}.lock`), owned = fstatSync(lock);
          if (actual.ino !== owned.ino || actual.dev !== owned.dev) throw fail();
          unlinkSync(`${path}.lock`); fsyncSync(directory);
        }
      } finally { if (lock != null) closeSync(lock); if (directory != null) closeSync(directory); if (fd != null) closeSync(fd); }
    }
  }
  function status() {
    let fd;
    try {
      fd = openLedger();
      try { lstatSync(`${path}.lock`); return { available: false, reason: 'budget_locked' }; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const state = read(fd);
      return state.halted ? { available: false, reason: 'budget_unavailable' }
        : state.total + cost > expected.capNanodollars ? { available: false, reason: 'budget_exhausted' }
          : { available: true, reason: null };
    } catch { return { available: false, reason: 'budget_unavailable' }; }
    finally { if (fd != null) closeSync(fd); }
  }
  function assertUsage(usage) {
    if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens > JEV_ATTEMPT_INPUT_TOKENS) {
      append('halt'); throw fail('usage_overrun');
    }
  }
  return { status, reserve: () => append('reserve'), assertUsage };
}
