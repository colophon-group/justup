// Provider protocol, spend and fake-network evaluation suite. No credentials or
// actual model calls; quality/latency approval needs a separate real benchmark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevClient, JEV_MODEL, planJevBatch, parseJevResponse } from './jev.mjs';
import { unapprovedJevBudgetTemplate, JEV_BUDGET_RESOURCE } from './jev-budget.mjs';

const at = Date.parse('2026-10-31T16:00:00Z');
const job = (id = 'synthetic-1', bodyText = 'The role includes a documented four day working week. '.repeat(5)) => ({
  id, title: 'Synthetic engineer', companyName: 'Example test company', bodyText,
  evidenceHash: `evidence-${id}`, evidence: { aiEligible: true, truncated: false },
});
const budgets = { calls: 100, inputTokens: 1_000_000, outputTokens: 100_000, costNanodollars: 42_000_000 };
const configuration = () => ({ enabled: true, authorizationApproved: true, token: 'synthetic-test-token', projectId: 'test-project',
  pricing: { confirmed: true, model: JEV_MODEL, version: 'official-2026-10-31', inputNanodollarsPerToken: 42, outputNanodollarsPerToken: 0 },
  budgets: { account: { ...budgets }, project: { ...budgets } }, maxRetries: 0 });
function installLedger(t, config, cap = 500_000_000) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'justup-provider-budget-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const part of ['queue', 'data', 'backups']) mkdirSync(join(dir, part), { mode: 0o700 });
  const price = config.pricing?.version ? config.pricing : configuration().pricing;
  const header = { ...unapprovedJevBudgetTemplate(), approvalId: `${JEV_BUDGET_RESOURCE}#issuecomment-1`, capNanodollars: cap,
    pricingVersion: price.version, inputNanodollarsPerToken: 42, outputNanodollarsPerToken: 0 };
  config.cumulativeBudget = { path: join(dir, 'queue', 'budget-ledger.jsonl'), excludedDirectories: [join(dir, 'data'), join(dir, 'backups')],
    approval: { approved: true, ledgerId: header.ledgerId, resourceId: JEV_BUDGET_RESOURCE, resourceSlug: header.resourceSlug, approvalId: header.approvalId, capNanodollars: cap } };
  writeFileSync(config.cumulativeBudget.path, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  return { dir, header, rows: () => readFileSync(config.cumulativeBudget.path, 'utf8').trim().split('\n').map(JSON.parse) };
}
const response = (request, choice = 'accepted') => ({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(request.questions).reverse().map((key) => [key,
  { type: 'choice', choice, confidence: 0.985, probabilities: { accepted: choice === 'accepted' ? 0.99 : 0.005,
    rejected: choice === 'rejected' ? 0.99 : 0.005, insufficient_evidence: choice === 'insufficient_evidence' ? 0.99 : 0.005 } }])),
usage: { input_tokens: 300, output_tokens: 24 } });
function fixture(t, config = configuration(), fetch = async (_url, options) => Response.json(response(JSON.parse(options.body)))) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  if (!Object.hasOwn(config, 'cumulativeBudget')) installLedger(t, config);
  const client = createJevClient({ db, config, fetch, now: () => at, sleep: async () => {} });
  return { db, client };
}

test('disabled, unapproved, missing-price and missing-budget configurations make no request', async (t) => {
  for (const config of [{}, { ...configuration(), authorizationApproved: false }, { ...configuration(), pricing: { confirmed: false } }, { ...configuration(), budgets: {} }]) {
    let calls = 0; const { client } = fixture(t, config, async () => { calls++; });
    assert.equal(client.available(), false);
    await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'dependency_unavailable' });
    assert.equal(calls, 0);
  }
});

test('ternary requests omit identities/URLs and response order does not change candidate IDs', async (t) => {
  let sent;
  const { db, client } = fixture(t, configuration(), async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
    sent = JSON.parse(options.body); return Response.json(response(sent));
  });
  const result = await client.classify({ ownerId: 'private-owner', condition: 'Four day week', jobs: [job('private-id-1'), job('private-id-2')] });
  assert.equal(sent.model, 'jev-1.14.0');
  assert.deepEqual(Object.keys(sent.questions.j_0000.criteria).sort(), ['accepted', 'insufficient_evidence', 'rejected']);
  assert(!JSON.stringify(sent).includes('private-')); assert(!JSON.stringify(sent).includes('sourceUrl'));
  assert.deepEqual(result.decisions.map((d) => d.id), ['private-id-1', 'private-id-2']);
  assert.equal(result.costNanodollars, 12600);
  assert.equal(db.prepare("SELECT input_tokens FROM demo_jev_usage WHERE scope='project'").get().input_tokens, 300);
});

test('adaptive plans obey candidate/byte/token bounds and never truncate weak evidence', () => {
  const small = Array.from({ length: 100 }, (_, i) => job(`small-${i}`));
  for (const size of [5, 12, 24]) {
    const plan = planJevBatch('Four day week', small, { maxCandidates: size });
    assert.equal(plan.selected.length, size); assert(plan.requestBytes <= 28_000); assert(plan.reservation.inputTokens <= 60_000);
  }
  const large = planJevBatch('Four day week', [job('oversized', 'x'.repeat(20_000)), job('good')]);
  assert.deepEqual(large.skipped, ['oversized']); assert.deepEqual(large.selected.map((j) => j.id), ['good']);
  assert.equal(planJevBatch('Four day week', [{ ...job(), evidence: { aiEligible: true, truncated: true } }]).selected.length, 0);
});

test('malformed, incomplete, extra, wrong-model and weak answers cannot become accepted', () => {
  const plan = planJevBatch('Four day week', [job()]);
  const good = response(plan.request);
  const variants = [ { ...good, model: 'jev-latest' }, { ...good, answers: {} },
    { ...good, answers: { ...good.answers, other: good.answers.j_0000 } },
    { ...good, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...good, answers: { j_0000: { ...good.answers.j_0000, choice: 'yes' } } },
    { ...good, answers: { j_0000: { ...good.answers.j_0000, probabilities: { accepted: 0.9, rejected: 0.9, insufficient_evidence: 0 } } } } ];
  for (const value of variants) assert.throws(() => parseJevResponse(value, plan.selected), { code: 'invalid_response' });
  good.answers.j_0000.confidence = 0.2;
  assert.equal(parseJevResponse(good, plan.selected).decisions[0].decision, 'insufficient_evidence');
});

test('account/project call, token and cost ceilings fail before network access', async (t) => {
  for (const scope of ['account', 'project']) for (const key of ['calls', 'inputTokens', 'outputTokens', 'costNanodollars']) {
    let calls = 0; const config = configuration(); config.budgets[scope][key] = key === 'calls' ? 1 : 2;
    const { client } = fixture(t, config, async (_url, options) => { calls++; return Response.json(response(JSON.parse(options.body))); });
    const invoke = () => client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] });
    if (key === 'calls') await invoke();
    await assert.rejects(invoke(), { code: 'budget_exhausted' });
    assert.equal(calls, key === 'calls' ? 1 : 0);
  }
});

test('ambiguous retries retain reservations and require fresh capacity', async (t) => {
  const config = configuration(); config.maxRetries = 1; config.budgets.account.calls = 1;
  let calls = 0;
  const { db, client } = fixture(t, config, async () => { calls++; throw new Error('fake network interruption'); });
  await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'budget_exhausted' });
  assert.equal(calls, 1);
  const used = db.prepare("SELECT * FROM demo_jev_usage WHERE scope='project'").get();
  assert(used.input_tokens > 300); assert.equal(used.ambiguous, 1);
});

test('timeouts, bad JSON, oversized responses and redirect errors fail without decisions', async (t) => {
  const modes = [ async () => new Promise(() => {}), async () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response('x'.repeat(70_000), { headers: { 'Content-Type': 'application/json' } }), async () => { throw new Error('redirect'); } ];
  for (const fetch of modes) {
    const config = configuration(); config.timeoutMs = 5;
    const { client } = fixture(t, config, fetch);
    await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), (e) => ['provider_timeout', 'invalid_response', 'provider_unavailable'].includes(e.code));
  }
});

test('deleting owner accounting retains anonymous project spend and cannot resurrect private rows', async (t) => {
  let finish;
  const { db, client } = fixture(t, configuration(), async (_url, options) => new Promise((resolve) => { finish = () => resolve(Response.json(response(JSON.parse(options.body)))); }));
  const promise = client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] });
  client.deleteAccountData('owner'); finish(); await promise;
  assert.equal(db.prepare("SELECT count(*) AS n FROM demo_jev_usage WHERE scope='account'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM demo_jev_reservations').get().n, 0);
  assert.equal(db.prepare("SELECT calls FROM demo_jev_usage WHERE scope='project'").get().calls, 1);
});

test('usage overruns retain measured charges and stop without returning a match', async (t) => {
  const { db, client } = fixture(t, configuration(), async (_url, options) => {
    const result = response(JSON.parse(options.body)); result.usage.input_tokens = 63_000;
    return Response.json(result);
  });
  await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'usage_overrun' });
  const used = db.prepare("SELECT * FROM demo_jev_usage WHERE scope='project'").get();
  assert.equal(used.input_tokens, 63_000); assert.equal(used.cost_nano, 2_646_000); assert.equal(used.ambiguous, 0);
});

test('already aborted requests do not reserve capacity and rate limits respect Retry-After', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let calls = 0; const delays = [], config = configuration(); config.maxRetries = 1;
  installLedger(t, config);
  const client = createJevClient({ db, config, now: () => at, sleep: async (ms) => { delays.push(ms); },
    fetch: async (_url, options) => { calls++; return calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }) : Response.json(response(JSON.parse(options.body))); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()], signal: controller.signal }), { code: 'cancelled' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM demo_jev_usage').get().n, 0);
  const result = await client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] });
  assert.equal(calls, 2); assert.deepEqual(delays, [2000]); assert.equal(result.ambiguousAttempts, 1);
});

test('missing, unapproved and corrupt aggregate ledgers make zero HTTP requests', async (t) => {
  for (const mode of ['missing', 'unapproved', 'corrupt']) {
    let calls = 0; const config = configuration();
    const ledger = installLedger(t, config);
    if (mode === 'missing') rmSync(config.cumulativeBudget.path);
    if (mode === 'unapproved') config.cumulativeBudget.approval.approved = false;
    if (mode === 'corrupt') appendFileSync(config.cumulativeBudget.path, 'partial');
    const { client } = fixture(t, config, async () => { calls++; throw new Error('HTTP must be blocked'); });
    assert.equal(client.available(), false);
    await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'budget_unavailable' });
    assert.equal(calls, 0); assert(ledger.dir);
  }
});

test('ambiguous retry pays two irreversible 64k reservations and a third attempt is blocked', async (t) => {
  const config = configuration(); config.maxRetries = 1;
  const ledger = installLedger(t, config, 64_000 * 42 * 2); let calls = 0;
  const { client } = fixture(t, config, async (_url, options) => {
    calls++; if (calls === 1) throw new Error('ambiguous fake failure');
    return Response.json(response(JSON.parse(options.body)));
  });
  const result = await client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] });
  assert.equal(result.attempts, 2); assert.equal(result.cumulativeReservedNanodollars, 64_000 * 42 * 2);
  assert.equal(ledger.rows().at(-1).reservedNanodollars, 64_000 * 42 * 2);
  client.deleteAccountData('owner');
  await assert.rejects(client.classify({ ownerId: 'new-account', condition: 'Four day week', jobs: [job()] }), { code: 'budget_exhausted' });
  assert.equal(calls, 2);
});

test('a fresh or restored SQLite database cannot replenish aggregate reservations', async (t) => {
  const config = configuration(), ledger = installLedger(t, config, 64_000 * 42); let calls = 0;
  const { client } = fixture(t, config, async (_url, options) => { calls++; return Response.json(response(JSON.parse(options.body))); });
  await client.classify({ ownerId: 'deleted-account', condition: 'Four day week', jobs: [job()] });
  client.deleteAccountData('deleted-account');
  // An empty SQLite database represents a restore predating every account/call.
  const { client: restored } = fixture(t, config, async () => { calls++; throw new Error('No refill after DB restore'); });
  await assert.rejects(restored.classify({ ownerId: 'recreated-account', condition: 'Four day week', jobs: [job()] }), { code: 'budget_exhausted' });
  assert.equal(ledger.rows().at(-1).reservedNanodollars, 64_000 * 42); assert.equal(calls, 1);
});

test('aggregate reservation is durable before fake network runs, and usage overruns halt future calls', async (t) => {
  const config = configuration(), ledger = installLedger(t, config); let calls = 0;
  const { client } = fixture(t, config, async (_url, options) => {
    calls++; assert.equal(ledger.rows().at(-1).reservedNanodollars, 64_000 * 42);
    const result = response(JSON.parse(options.body)); result.usage.input_tokens = 64_001;
    return Response.json(result);
  });
  await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'usage_overrun' });
  assert.equal(ledger.rows().at(-1).kind, 'halt'); assert.equal(client.available(), false);
  await assert.rejects(client.classify({ ownerId: 'owner', condition: 'Four day week', jobs: [job()] }), { code: 'budget_unavailable' });
  assert.equal(calls, 1);
});

test('reviewed synthetic train/heldout labels exercise all three protocol outcomes', () => {
  const cases = JSON.parse(readFileSync(new URL('./evals/matching-cases-v1.json', import.meta.url), 'utf8'));
  assert.equal(cases.providerMeasured, false);
  for (const split of ['development', 'heldout']) {
    const entries = cases.cases.filter((c) => c.split === split);
    assert.deepEqual([...new Set(entries.map((c) => c.expected))].sort(), ['accepted', 'insufficient_evidence', 'rejected']);
    for (const c of entries) {
      const plan = planJevBatch(c.condition, [job(c.id, c.evidence.repeat(6))]);
      assert.equal(parseJevResponse(response(plan.request, c.expected), plan.selected).decisions[0].decision, c.expected);
      assert(c.rationale.length > 20);
    }
  }
});
