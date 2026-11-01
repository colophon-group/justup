// Monotonic anonymous spend-cap tests. All approvals/prices are synthetic fixture
// data; no human approval, provider key, real request or production state is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync,
  chmodSync, symlinkSync, linkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createJevBudget, unapprovedJevBudgetTemplate, JEV_BUDGET_RESOURCE, JEV_BUDGET_SLUG,
  JEV_BUDGET_IDENTITY_PROFILE, JEV_BUDGET_LEGACY_IDENTITY_PROFILE, JEV_BUDGET_LEGACY_SLUG } from './jev-budget.mjs';

const MODEL = 'jev-1.14.0', COST = 64_000 * 42;
const pricing = { confirmed: true, model: MODEL, version: 'synthetic-account-price', inputNanodollarsPerToken: 42, outputNanodollarsPerToken: 0 };
function fixture(t, cap = 500_000_000) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'justup-budget-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ['queue', 'data', 'backups']) mkdirSync(join(dir, part), { mode: 0o700 });
  const header = { ...unapprovedJevBudgetTemplate(), approvalId: `${JEV_BUDGET_RESOURCE}#issuecomment-1`, capNanodollars: cap,
    pricingVersion: pricing.version, inputNanodollarsPerToken: 42, outputNanodollarsPerToken: 0 };
  const config = { path: join(dir, 'queue', 'budget-ledger.jsonl'), excludedDirectories: [join(dir, 'data'), join(dir, 'backups')],
    approval: { approved: true, ledgerId: header.ledgerId, resourceId: JEV_BUDGET_RESOURCE, resourceSlug: header.resourceSlug, approvalId: header.approvalId, capNanodollars: cap } };
  writeFileSync(config.path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  const options = { config, model: MODEL, pricing, databasePath: join(dir, 'data', 'preview.sqlite') };
  return { dir, config, header, options, budget: createJevBudget(options),
    rows: () => readFileSync(config.path, 'utf8').trim().split('\n').map(JSON.parse) };
}

const hash = (row) => createHash('sha256').update(JSON.stringify(row)).digest('hex');
function historicalRows(header) {
  const rows = [header];
  for (const sequence of [1, 2]) {
    const unsigned = { kind: 'reserve', sequence, previousHash: hash(rows.at(-1)),
      costNanodollars: COST, reservedNanodollars: sequence * COST };
    rows.push({ ...unsigned, hash: hash(unsigned) });
  }
  return `${rows.map(JSON.stringify).join('\n')}\n`;
}
function historicalFixture(t, cap = COST * 4) {
  const f = fixture(t, cap);
  // The persisted version-1 field set and two reservations are constructed
  // independently of the current template and append implementation.
  f.header = { schemaVersion: 1, kind: 'approval', ledgerId: '00000000-0000-4000-8000-000000000049',
    resourceId: JEV_BUDGET_RESOURCE, resourceSlug: 'demo-jev-evaluation-budget',
    approvalId: 'operator-user-turn:00000000-0000-7000-8000-000000000001', capNanodollars: cap,
    model: MODEL, pricingVersion: pricing.version, inputNanodollarsPerToken: 42, outputNanodollarsPerToken: 0,
    maxInputTokensPerAttempt: 64_000 };
  f.config.identityProfile = JEV_BUDGET_LEGACY_IDENTITY_PROFILE;
  f.config.approval = { approved: true, ledgerId: f.header.ledgerId, resourceId: f.header.resourceId,
    resourceSlug: f.header.resourceSlug, approvalId: f.header.approvalId, capNanodollars: cap };
  writeFileSync(f.config.path, historicalRows(f.header));
  f.budget = createJevBudget(f.options);
  return f;
}

test('new unapproved templates use canonical identity and retain the version-1 field set', (t) => {
  const f = fixture(t);
  assert.equal(JEV_BUDGET_SLUG, 'jev-evaluation-budget');
  assert.equal(JEV_BUDGET_LEGACY_IDENTITY_PROFILE, 'legacy-v1');
  assert.equal(JEV_BUDGET_LEGACY_SLUG, 'demo-jev-evaluation-budget');
  assert.equal(f.header.resourceSlug, JEV_BUDGET_SLUG);
  assert.equal(f.header.schemaVersion, 1);
  assert.equal(Object.hasOwn(f.header, 'identityProfile'), false);
  const template = unapprovedJevBudgetTemplate();
  assert.equal(template.approvalId, null); assert.equal(template.pricingVersion, null);
  assert.equal(Object.hasOwn(template, 'approved'), false);
  assert.equal(template.capNanodollars, 500_000_000);
  assert.equal(f.budget.reserve().sequence, 1); // Omitted profile is canonical.
  const explicit = createJevBudget({ ...f.options, config: { ...f.config, identityProfile: JEV_BUDGET_IDENTITY_PROFILE } });
  assert.equal(explicit.status().available, true); assert.equal(explicit.reserve().sequence, 2);
});

test('explicit historical binding appends without changing nonzero ledger bytes, identity or hash history', (t) => {
  const f = historicalFixture(t), prefix = readFileSync(f.config.path), oldRows = f.rows();
  assert.equal(f.budget.status().available, true);
  assert.deepEqual(f.budget.reserve(), { sequence: 3, costNanodollars: COST, reservedNanodollars: COST * 3 });
  writeFileSync(join(f.dir, 'data', 'preview.sqlite'), 'older application database restored');
  assert.deepEqual(createJevBudget(f.options).reserve(), { sequence: 4, costNanodollars: COST, reservedNanodollars: COST * 4 });
  rmSync(join(f.dir, 'data', 'preview.sqlite')); // Deletion cannot replenish the separate ledger.
  assert.equal(createJevBudget(f.options).status().reason, 'budget_exhausted');
  assert.throws(() => createJevBudget(f.options).reserve(), { code: 'budget_exhausted' });
  const bytes = readFileSync(f.config.path), rows = f.rows();
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  assert.deepEqual(rows.slice(0, oldRows.length), oldRows);
  assert.equal(rows[3].previousHash, hash(oldRows.at(-1)));
  assert.equal(rows[4].previousHash, hash(rows[3]));
  for (const row of rows.slice(3)) { const { hash: digest, ...unsigned } = row; assert.equal(digest, hash(unsigned)); }
  assert.equal(rows[0].resourceSlug, JEV_BUDGET_LEGACY_SLUG);
  assert(!existsSync(`${f.config.path}.lock`));
});

test('unknown, implicit and mixed identities fail closed without rewriting historical state', async (t) => {
  const cases = [
    ['historical identity without explicit profile', (f) => { delete f.config.identityProfile; }],
    ['historical identity with canonical profile', (f) => { f.config.identityProfile = JEV_BUDGET_IDENTITY_PROFILE; }],
    ['unknown profile', (f) => { f.config.identityProfile = 'future-v2'; }],
    ['unreleased profile spelling', (f) => { f.config.identityProfile = 'legacy-demo-v1'; }],
    ['null profile', (f) => { f.config.identityProfile = null; }],
    ['canonical approval with historical header', (f) => { f.config.approval.resourceSlug = JEV_BUDGET_SLUG; }],
    ['canonical header with historical approval', (f) => { f.header.resourceSlug = JEV_BUDGET_SLUG; }],
    ['unknown matching slug', (f) => { f.header.resourceSlug = f.config.approval.resourceSlug = 'other-budget'; }],
    ['unknown matching resource', (f) => { f.header.resourceId = f.config.approval.resourceId = `${JEV_BUDGET_RESOURCE}0`; }],
    ['different ledger UUID', (f) => { f.config.approval.ledgerId = '00000000-0000-4000-8000-000000000050'; }],
    ['different approval', (f) => { f.config.approval.approvalId = `${JEV_BUDGET_RESOURCE}#issuecomment-2`; }],
    ['different cap', (f) => { f.config.approval.capNanodollars += COST; }],
    ['different model', (f) => { f.options.model = f.options.pricing.model = 'other-model'; }],
    ['different price', (f) => { f.options.pricing.inputNanodollarsPerToken = 43; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, (t) => {
    const f = historicalFixture(t); f.options.pricing = { ...pricing };
    const headerLine = readFileSync(f.config.path, 'utf8').split('\n')[0];
    mutate(f);
    // Rehash synthetic header variants so identity rejection is not merely a
    // consequence of an unrelated broken hash chain.
    if (JSON.stringify(f.header) !== headerLine) {
      writeFileSync(f.config.path, historicalRows(f.header));
    }
    const before = readFileSync(f.config.path), denied = createJevBudget(f.options);
    assert.equal(denied.status().available, false);
    assert.throws(() => denied.reserve(), { code: 'budget_unavailable' });
    assert.deepEqual(readFileSync(f.config.path), before);
  });
});

test('full 64k reservations survive restart, database rollback and account lifecycle without refunds', (t) => {
  const f = fixture(t, COST * 3);
  assert.equal(f.budget.reserve().reservedNanodollars, COST);
  writeFileSync(join(f.dir, 'data', 'preview.sqlite'), 'old database restored; account deleted and recreated');
  const restarted = createJevBudget(f.options);
  assert.equal(restarted.reserve().reservedNanodollars, COST * 2);
  assert.equal(createJevBudget(f.options).reserve().reservedNanodollars, COST * 3);
  assert.throws(() => restarted.reserve(), { code: 'budget_exhausted' });
  assert.equal(f.rows().length, 4); assert(!existsSync(`${f.config.path}.lock`));
  const text = readFileSync(f.config.path, 'utf8');
  for (const privateField of ['ownerId', 'accountId', 'query', 'evidence', 'token']) assert(!text.includes(privateField));
});

test('a crash after reservation and before a request consumes the allowance irreversibly', (t) => {
  const f = fixture(t, COST);
  f.budget.reserve(); // Process can die here; no provider request is made.
  assert.equal(createJevBudget(f.options).status().reason, 'budget_exhausted');
  assert.throws(() => createJevBudget(f.options).reserve(), { code: 'budget_exhausted' });
});

test('concurrent processes cannot reserve beyond the cumulative cap', async (t) => {
  const f = fixture(t, COST * 2); f.budget.reserve();
  const source = `import {createJevBudget} from ${JSON.stringify(new URL('./jev-budget.mjs', import.meta.url).href)};
    const budget=createJevBudget(JSON.parse(process.argv[1]));
    try { console.log(JSON.stringify(budget.reserve())); } catch(e) { console.log(JSON.stringify({error:e.code})); }`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(f.options)], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { err += v; });
    child.on('error', reject); child.on('exit', (code) => code ? reject(new Error(err)) : resolve(JSON.parse(out)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((r) => r.reservedNanodollars === COST * 2).length, 1);
  assert(['budget_exhausted', 'budget_locked'].includes(results.find((r) => r.error)?.error));
  assert.equal(f.rows().at(-1).reservedNanodollars, COST * 2);
});

test('retained crash locks require operator reconciliation and are never silently removed', (t) => {
  for (const prepare of [fixture, historicalFixture]) {
    const f = prepare(t), before = readFileSync(f.config.path);
    writeFileSync(`${f.config.path}.lock`, '', { mode: 0o600 });
    assert.equal(f.budget.status().reason, 'budget_locked'); assert.throws(() => f.budget.reserve(), { code: 'budget_locked' });
    assert(existsSync(`${f.config.path}.lock`)); assert.deepEqual(readFileSync(f.config.path), before);
  }
});

test('unapproved/missing/mismatched approvals, prices and caps cannot initialize or spend', (t) => {
  const f = fixture(t);
  for (const override of [{ approval: { ...f.config.approval, approved: false } },
    { approval: { ...f.config.approval, approvalId: `${JEV_BUDGET_RESOURCE}#issuecomment-2` } },
    { approval: { ...f.config.approval, capNanodollars: 500_000_001 } },
    { path: join(f.dir, 'queue', 'missing.jsonl') }]) {
    const denied = createJevBudget({ ...f.options, config: { ...f.config, ...override } });
    assert.equal(denied.status().available, false); assert.throws(() => denied.reserve(), { code: 'budget_unavailable' });
  }
  assert.equal(createJevBudget({ ...f.options, pricing: { ...pricing, version: 'different-account-price' } }).status().available, false);
  assert.equal(createJevBudget({ ...f.options, pricing: { ...pricing, confirmed: false } }).status().available, false);
  assert(!existsSync(join(f.dir, 'queue', 'missing.jsonl'))); assert.equal(f.rows().length, 1);
  const unapproved = unapprovedJevBudgetTemplate(); assert.equal(unapproved.approvalId, null); assert.equal(unapproved.inputNanodollarsPerToken, null);
});

test('protected approval may bind the resource slug to a trusted user-turn record', (t) => {
  const f = fixture(t), approvalId = 'operator-user-turn:00000000-0000-7000-8000-000000000001';
  f.config.approval.approvalId = approvalId; f.header.approvalId = approvalId;
  writeFileSync(f.config.path, `${JSON.stringify(f.header)}\n`);
  assert.equal(createJevBudget(f.options).status().available, true);
  assert.equal(createJevBudget({ ...f.options, config: { ...f.config,
    approval: { ...f.config.approval, resourceSlug: 'different-resource' } } }).status().available, false);
});

test('corrupt hash chains, duplicate keys, partial writes, blank/oversized files fail closed', (t) => {
  const f = fixture(t); f.budget.reserve(); const good = readFileSync(f.config.path);
  const variants = [good.subarray(0, good.length - 1), Buffer.from(''), Buffer.from(`${good.toString()}partial`),
    Buffer.from(good.toString().replace('"sequence":1', '"sequence":2')),
    Buffer.from(good.toString().replace('"kind":"reserve"', '"kind":"reserve","kind":"reserve"')),
    Buffer.alloc(4 * 1024 * 1024 + 1, 10)];
  for (const value of variants) {
    writeFileSync(f.config.path, value); assert.equal(f.budget.status().available, false);
  }
  writeFileSync(f.config.path, good); appendFileSync(f.config.path, '\n');
  assert.throws(() => f.budget.reserve(), { code: 'budget_unavailable' });
  assert(existsSync(`${f.config.path}.lock`)); // Failed validation cannot unlock/reset damaged state.
});

test('unsafe modes, symlinks and preview data/backup paths are rejected', (t) => {
  for (const prepare of [fixture, historicalFixture]) {
    const f = prepare(t); chmodSync(f.config.path, 0o640);
    assert.equal(f.budget.status().available, false); chmodSync(f.config.path, 0o600);
    chmodSync(join(f.dir, 'queue'), 0o750); assert.equal(f.budget.status().available, false); chmodSync(join(f.dir, 'queue'), 0o700);
    const link = join(f.dir, 'queue', 'link.jsonl'); symlinkSync(f.config.path, link);
    assert.equal(createJevBudget({ ...f.options, config: { ...f.config, path: link } }).status().available, false);
    const alias = join(f.dir, 'queue-alias'); symlinkSync(join(f.dir, 'queue'), alias);
    assert.equal(createJevBudget({ ...f.options, config: { ...f.config, path: join(alias, 'budget-ledger.jsonl') } }).status().available, false);
    for (const part of ['data', 'backups']) for (const name of ['ledger.jsonl', '..ledger.jsonl']) {
      const path = join(f.dir, part, name); writeFileSync(path, `${JSON.stringify(f.header)}\n`, { mode: 0o600 });
      assert.equal(createJevBudget({ ...f.options, config: { ...f.config, path } }).status().available, false);
    }
    linkSync(f.config.path, join(f.dir, 'queue', 'hard-link.jsonl'));
    assert.equal(f.budget.status().available, false);
  }
});

test('provider usage beyond its reserved input maximum durably halts further spending', (t) => {
  for (const prepare of [fixture, historicalFixture]) {
    const f = prepare(t); f.budget.reserve();
    assert.throws(() => f.budget.assertUsage({ input_tokens: 64_001, output_tokens: 1 }), { code: 'usage_overrun' });
    assert.equal(f.rows().at(-1).kind, 'halt'); assert.equal(createJevBudget(f.options).status().available, false);
    assert.throws(() => createJevBudget(f.options).reserve(), { code: 'budget_unavailable' });
  }
});
