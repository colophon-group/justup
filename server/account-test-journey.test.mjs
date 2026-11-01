// The reusable operator journey through actual HTTP/auth/SQLite/queue and the
// fixed Resend protocol; only its network transport and mailbox are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from './main.mjs';
import { createEmailVerificationRunner } from './email-verification.mjs';
import { createResendClient } from './account-provider-clients.mjs';
import { createRunner } from './runner.mjs';
import { syntheticPolicyProof } from './policy-test-fixtures.mjs';
import { runAccountTestJourney } from '../scripts/account-test-journey.mjs';

async function fixture(t) {
  const origin = 'https://preview.justup.work', sourceCommit = 'a'.repeat(40), buildIdentity = 'b'.repeat(64);
  const config = { dbPath: ':memory:', allowedOrigin: origin, sourceCommit, buildIdentity, requiresInvitation: false,
    policiesReviewed: true, policyVersion: 'synthetic-v1', privacyUrl: `${origin}/privacy.html`, usageUrl: `${origin}/usage.html`, csrfSecret: 'c'.repeat(32), emailVerificationEnabled: true,
    policyLocales: { de: { privacyUrl: `${origin}/privacy.de.html`, usageUrl: `${origin}/usage.de.html`, version: 'synthetic-v1', reviewed: true } },
    policyAssetProof: syntheticPolicyProof({ origin, sourceCommit, version: 'synthetic-v1', locales: ['de'] }),
    readiness: () => ({ capabilities: { emailVerification: true } }) };
  const app = await createApplication({ config });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const sent = [];
  const client = createResendClient({ apiKey: 'synthetic_sending_key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['authorized@example.org']); assert.equal(body.from, 'Justup <accounts@notify.justup.work>');
    assert.equal(body.subject, 'Dein Code für Justup');
    sent.push({ code: body.text.match(/\d{8}/)[0], key: options.headers['Idempotency-Key'] });
    return new Response(JSON.stringify({ id: 'synthetic-resend-acceptance' }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const email = createEmailVerificationRunner({ db: app.store.db, tasks: app.tasks, client,
    config: { ...config, emailVerification: { enabled: true, apiKey: 'synthetic_sending_key', verificationKey: 'v'.repeat(32), maxDaily: 1, maxMonthly: 1 } } });
  const runner = createRunner({ tasks: app.tasks, handlers: { email_verification: email.runTask } });
  const packet = { apiBase: `http://127.0.0.1:${app.server.address().port}/api/v1`, origin, sourceCommit, buildIdentity,
    policyVersion: 'synthetic-v1', locale: 'de', recipient: 'authorized@example.org', mode: 'synthetic' };
  let recovery, cleared = false;
  const options = { packet, saveRecovery: value => { recovery = value; }, clearRecovery: () => { cleared = true; recovery = null; },
    readCode: async () => sent.at(-1).code, pumpQueue: () => runner.runOnce(), wait: async () => {} };
  return { app, packet, options, sent, recovery: () => recovery, cleared: () => cleared };
}

test('bounded journey sends once through the existing adapter, activates separately and deletes all account proof', async t => {
  const f = await fixture(t);
  const receipt = await runAccountTestJourney(f.options);
  assert.equal(receipt.delivery, 'queue_sent'); assert.equal(receipt.emailControl, 'synthetic_code');
  assert.equal(receipt.stripeTestMode, 'not_run'); assert.equal(receipt.runtimeConfiguration, 'unchanged');
  assert.equal(receipt.freePeriod, 'explicit_ordinary_week'); assert.equal(receipt.accountDeletion, 'confirmed');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].key, /^justup-verification\/[a-f0-9-]{36}$/);
  assert.equal(f.cleared(), true); assert.equal(f.recovery(), null);
  for (const table of ['auth_accounts', 'auth_sessions', 'auth_registration_acceptance', 'justup_email_challenges', 'access_identities', 'access_free_periods', 'justup_tasks']) {
    assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  }
  for (const privateValue of [f.packet.recipient, f.sent[0].code, 'password', 'csrf', 'cookie']) {
    assert.equal(JSON.stringify(receipt).includes(privateValue), false);
  }
});

test('a mailbox callback failure still deletes the generated account and leaves no personal proof', async t => {
  const f = await fixture(t);
  await assert.rejects(runAccountTestJourney({ ...f.options, readCode: async () => { throw Error('Do not log private callback detail'); } }), { code: 'journey_failed' });
  assert.equal(f.sent.length, 1); assert.equal(f.cleared(), true);
  for (const table of ['auth_accounts', 'auth_registration_acceptance', 'justup_email_challenges', 'justup_tasks']) {
    assert.equal(f.app.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  }
});

test('a changed candidate stops before registration, send or recovery state', async t => {
  const f = await fixture(t);
  await assert.rejects(runAccountTestJourney({ ...f.options, packet: { ...f.packet, sourceCommit: 'e'.repeat(40) } }), { code: 'candidate_changed' });
  assert.equal(f.sent.length, 0); assert.equal(f.recovery(), undefined);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_accounts').get().n, 0);
});

test('a lost registration response recovers only the generated account and confirms its deletion', async t => {
  const f = await fixture(t);
  await assert.rejects(runAccountTestJourney({ ...f.options, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/auth/register')) { await response.arrayBuffer(); throw Error('Synthetic lost reply.'); }
    return response;
  } }), { code: 'request_failed' });
  assert.equal(f.sent.length, 0); assert.equal(f.cleared(), true);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_accounts').get().n, 0);
});

test('unconfirmed cleanup retains protected recovery data and cannot return a successful receipt', async t => {
  const f = await fixture(t);
  await assert.rejects(runAccountTestJourney({ ...f.options, fetchImpl: async (url, options) => {
    if (options.method === 'DELETE') return new Response(JSON.stringify({ error: { code: 'deletion_unavailable' } }), { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    return fetch(url, options);
  } }), { code: 'cleanup_unconfirmed' });
  assert.equal(f.cleared(), false); assert.equal(typeof f.recovery().password, 'string');
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_accounts').get().n, 1);
  // Reconcile only this protected generated account; never leave a test fixture.
  const owner = await f.app.auth.login(f.recovery());
  await f.app.auth.deleteAccount(owner.token, f.recovery().password);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM auth_registration_acceptance').get().n, 0);
});

test('a mismatched operator HTTPS origin is rejected before network, recovery or mailbox side effects', async () => {
  const approved = { apiBase: 'https://approved.example/api/v1', origin: 'https://approved.example',
    sourceCommit: 'a'.repeat(40), buildIdentity: 'b'.repeat(64), policyVersion: '2026-11-01.1',
    locale: 'en', recipient: 'authorized@example.org', mode: 'operator-mailbox' };
  for (const patch of [
    { apiBase: 'https://different.example/api/v1' },
    { apiBase: 'https://approved.example.evil.example/api/v1' },
    { apiBase: 'https://approved.example:444/api/v1' },
    { apiBase: 'http://127.0.0.1:1234/api/v1' },
    { apiBase: 'https://different.example/api/v1', mode: 'synthetic' },
  ]) {
    const calls = { network: 0, recovery: 0, clear: 0, mailbox: 0, queue: 0 };
    await assert.rejects(runAccountTestJourney({ packet: { ...approved, ...patch },
      fetchImpl: async () => { calls.network++; throw Error('Network must not run.'); },
      saveRecovery: () => { calls.recovery++; }, clearRecovery: () => { calls.clear++; },
      readCode: async () => { calls.mailbox++; return '12345678'; },
      pumpQueue: () => { calls.queue++; },
    }), { code: 'invalid_packet' });
    assert.deepEqual(calls, { network: 0, recovery: 0, clear: 0, mailbox: 0, queue: 0 });
  }
});

test('a same-origin operator packet reaches only its approved HTTPS API before candidate admission', async () => {
  const origin = 'https://approved.example', calls = [];
  const packet = { apiBase: origin + '/api/v1', origin, sourceCommit: 'a'.repeat(40), buildIdentity: 'b'.repeat(64),
    policyVersion: '2026-11-01.1', locale: 'en', recipient: 'authorized@example.org', mode: 'operator-mailbox' };
  let recovery = 0, mailbox = 0;
  await assert.rejects(runAccountTestJourney({ packet,
    fetchImpl: async url => {
      calls.push(url);
      return new Response(JSON.stringify({ sourceCommit: 'e'.repeat(40), buildIdentity: packet.buildIdentity, schemaVersion: 2 }),
        { headers: { 'Cache-Control': 'private, no-store' } });
    },
    saveRecovery: () => { recovery++; }, clearRecovery: () => {},
    readCode: async () => { mailbox++; return '12345678'; },
  }), { code: 'candidate_changed' });
  assert.deepEqual(calls, [origin + '/api/v1/version']);
  assert.equal(recovery, 0); assert.equal(mailbox, 0);
});

test('operator entrypoint rejects public packet files and synthetic mode before any HTTP mutation', t => {
  const root = mkdtempSync(join(tmpdir(), 'justup-mailbox-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entrypoint = new URL('../scripts/account-test-journey.mjs', import.meta.url);
  for (const [name, mode, packet, code] of [
    ['public.json', 0o644, { mode: 'operator-mailbox', recipient: 'private@example.org' }, 'invalid_private_file'],
    ['synthetic.json', 0o600, { mode: 'synthetic', recipient: 'private@example.org' }, 'invalid_packet'],
  ]) {
    const path = join(root, name); writeFileSync(path, JSON.stringify(packet), { mode });
    const result = spawnSync(process.execPath, [entrypoint.pathname, '--approved-packet', path, '--private-recovery', join(root, 'recovery.json')], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Account test journey failed: ${code}.\n`);
  }
});
