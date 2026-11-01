// Bounded disposable-account HTTP proof. Import for synthetic contracts or run
// the explicit protected operator entrypoint after its recipient packet is reviewed.
import { randomBytes } from 'node:crypto';
import { openSync, readFileSync, writeFileSync, closeSync, lstatSync, unlinkSync, fsyncSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizedEmail } from '../server/account-provider-clients.mjs';

const LOCALES = ['en', 'de', 'fr', 'it', 'es'];
const fail = code => Object.assign(new Error('Account test journey did not complete.'), { code });
const requireProof = (condition, code) => { if (!condition) throw fail(code); };
function endpoint(value) {
  const url = new URL(value);
  requireProof(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/v1'
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'invalid_packet');
  return url.href.replace(/\/$/, '');
}
function validatePacket(packet) {
  requireProof(packet && typeof packet === 'object' && !Array.isArray(packet)
    && Object.keys(packet).every(key => ['apiBase', 'origin', 'sourceCommit', 'buildIdentity', 'policyVersion', 'locale', 'recipient', 'mode', 'inviteCode'].includes(key))
    && /^[a-f0-9]{40}$/.test(packet.sourceCommit ?? '') && typeof packet.buildIdentity === 'string' && packet.buildIdentity.length > 0 && packet.buildIdentity.length <= 128
    && /^[A-Za-z0-9_.:-]{1,100}$/.test(packet.policyVersion ?? '') && LOCALES.includes(packet.locale)
    && ['synthetic', 'operator-mailbox'].includes(packet.mode)
    && typeof packet.recipient === 'string' && normalizedEmail(packet.recipient) === packet.recipient
    && (packet.inviteCode === undefined || typeof packet.inviteCode === 'string' && packet.inviteCode.length <= 256), 'invalid_packet');
  const origin = new URL(packet.origin);
  requireProof(origin.origin === packet.origin && (origin.protocol === 'https:'
    || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)), 'invalid_packet');
  const base = endpoint(packet.apiBase), target = new URL(base);
  // The operator packet cannot authorize a second destination. Imported
  // synthetic fixtures may use only a loopback API for their local transport.
  requireProof(target.origin === origin.origin || packet.mode === 'synthetic'
    && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'invalid_packet');
  return base;
}

export async function runAccountTestJourney({ packet, readCode, saveRecovery, clearRecovery,
  pumpQueue = async () => {}, wait = () => delay(1000), fetchImpl = fetch } = {}) {
  const base = validatePacket(packet);
  requireProof(typeof readCode === 'function' && typeof saveRecovery === 'function' && typeof clearRecovery === 'function'
    && typeof pumpQueue === 'function' && typeof wait === 'function' && typeof fetchImpl === 'function', 'invalid_packet');
  const username = `proof-${randomBytes(10).toString('hex')}`, password = randomBytes(32).toString('base64url');
  const jar = new Map(); let csrf, attempted = false, cleanupVerified = false, failed = null;
  async function request(path, method = 'GET', body) {
    const signal = AbortSignal.timeout(5000);
    let response;
    try {
      response = await fetchImpl(base + path, { method, redirect: 'error', signal,
        headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'X-Justup-Locale': packet.locale,
          ...(method === 'GET' ? {} : { Origin: packet.origin, 'X-CSRF-Token': csrf ?? '', 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requireProof(response.body && response.headers.get('cache-control')?.includes('no-store'), 'invalid_response');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength; requireProof(size <= 65_536, 'invalid_response'); chunks.push(Buffer.from(chunk));
      }
      const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'), index = pair.indexOf('=');
        const key = pair.slice(0, index), value = pair.slice(index + 1);
        if (['__Host-justup_session', '__Host-justup_csrf', '__Host-justup_visitor', 'justup_session', 'justup_csrf', 'justup_visitor'].includes(key)) jar.set(key, value);
      }
      if (typeof json.csrfToken === 'string') csrf = json.csrfToken;
      return { status: response.status, body: json };
    } catch (error) { throw fail(error?.code === 'invalid_response' ? 'invalid_response' : 'request_failed'); }
  }
  async function session() {
    const result = await request('/session'); requireProof(result.status === 200, 'session_failed'); return result.body;
  }
  async function checkCandidate() {
    const version = await request('/version');
    requireProof(version.status === 200 && version.body.sourceCommit === packet.sourceCommit
      && version.body.buildIdentity === packet.buildIdentity && version.body.schemaVersion === 2, 'candidate_changed');
    const state = await session();
    requireProof(state.policies?.reviewed === true && state.policies.locale === packet.locale
      && state.policies.version === packet.policyVersion, 'policy_changed');
    return state;
  }
  try {
    const guest = await checkCandidate();
    requireProof(guest.user === null && guest.authentication?.registrationEnabled === true, 'registration_unavailable');
    // This protected recovery record is required before the first mutation. A
    // crash/lost reply can therefore be reconciled without printing credentials.
    await saveRecovery({ schemaVersion: 1, apiBase: base, origin: packet.origin, locale: packet.locale,
      sourceCommit: packet.sourceCommit, buildIdentity: packet.buildIdentity, username, password });
    attempted = true;
    const registered = await request('/auth/register', 'POST', { username, password,
      ...(packet.inviteCode === undefined ? {} : { inviteCode: packet.inviteCode }),
      acceptance: { usageVersion: packet.policyVersion, locale: packet.locale, adultAndCapable: true } });
    requireProof(registered.status === 201 && registered.body.user?.username === username
      && registered.body.access?.kind === 'limited' && registered.body.access.fullAccess === false
      && registered.body.access.canActivateFreePeriod === false, 'registration_failed');
    const ownerId = registered.body.user.id;
    await checkCandidate();
    const started = await request('/account/verification', 'POST', { email: packet.recipient, requestKey: 'bounded-proof-send' });
    requireProof(started.status === 202 && started.body.verification?.state === 'pending', 'send_not_queued');
    const challengeId = started.body.verification.challengeId;
    let verification;
    for (let n = 0; n < 10; n++) {
      await pumpQueue();
      const status = await request('/account/verification');
      requireProof(status.status === 200, 'delivery_failed'); verification = status.body.verification;
      if (verification?.state === 'sent') break;
      requireProof(verification?.state === 'pending', 'delivery_failed');
      if (n < 9) await wait();
    }
    requireProof(verification?.state === 'sent' && verification.challengeId === challengeId
      && verification.challengeLocale === packet.locale, 'delivery_unconfirmed');
    const code = await readCode({ challengeId, locale: packet.locale, expiresAt: verification.expiresAt });
    requireProof(typeof code === 'string' && /^\d{8}$/.test(code), 'mailbox_code_required');
    await checkCandidate();
    const confirmed = await request('/account/verification/confirm', 'POST', { challengeId, code });
    requireProof(confirmed.status === 200 && confirmed.body.verification?.state === 'verified', 'control_unconfirmed');
    const ready = await session();
    requireProof(ready.user?.id === ownerId && ready.access?.kind === 'ready' && ready.access.fullAccess === false
      && ready.access.canActivateFreePeriod === true, 'unexpected_access');
    const activated = await request('/access/activate', 'POST', {});
    requireProof(activated.status === 200 && activated.body.access?.kind === 'free' && activated.body.access.fullAccess === true
      && activated.body.access.legacy === false, 'activation_failed');
    const period = Date.parse(activated.body.access.until) - Date.parse(activated.body.serverTime);
    requireProof(period > 7 * 86_400_000 - 5000 && period <= 7 * 86_400_000, 'unexpected_period');
    const replay = await request('/account/verification/confirm', 'POST', { challengeId, code });
    requireProof(replay.status === 400 && replay.body.error?.code === 'verification_invalid', 'replay_accepted');
  } catch (error) { failed = error?.code ?? 'journey_failed'; }
  finally {
    if (attempted) {
      try {
        // Recover a lost registration reply using only this generated account.
        const current = await session();
        if (current.user?.username !== username) {
          const login = await request('/auth/login', 'POST', { username, password });
          requireProof(login.status === 200 && login.body.user?.username === username, 'cleanup_unconfirmed');
        }
        const removed = await request('/account', 'DELETE', { password });
        requireProof(removed.status === 200 && removed.body.deleted === true, 'cleanup_unconfirmed');
        requireProof((await session()).user === null, 'cleanup_unconfirmed');
        const denied = await request('/auth/login', 'POST', { username, password });
        requireProof(denied.status === 401 && denied.body.error?.code === 'invalid_credentials', 'cleanup_unconfirmed');
        cleanupVerified = true; await clearRecovery();
      } catch { failed = 'cleanup_unconfirmed'; }
    }
  }
  if (failed) throw fail(failed);
  return { schemaVersion: 1, sourceCommit: packet.sourceCommit, buildIdentity: packet.buildIdentity, locale: packet.locale,
    policyVersion: packet.policyVersion, delivery: 'queue_sent',
    emailControl: packet.mode === 'synthetic' ? 'synthetic_code' : 'operator_mailbox_code',
    freePeriod: 'explicit_ordinary_week', replay: 'rejected', accountDeletion: cleanupVerified ? 'confirmed' : 'unconfirmed',
    stripeTestMode: 'not_run', runtimeConfiguration: 'unchanged' };
}

function protectedJson(path) {
  requireProof(isAbsolute(path), 'invalid_private_file');
  const info = lstatSync(path);
  requireProof(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o600 && info.size <= 8192, 'invalid_private_file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function mailboxCode() {
  requireProof(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function', 'mailbox_input_unavailable');
  process.stdout.write('Enter the authorized mailbox code (input hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    const previousRaw = process.stdin.isRaw;
    const finish = (error) => {
      clearTimeout(timer); process.stdin.off('data', onData); process.stdin.setRawMode(previousRaw); process.stdin.pause();
      process.stdout.write('\n'); error ? reject(error) : resolve(value);
    };
    const onData = bytes => {
      for (const char of bytes.toString('utf8')) {
        if (char === '\u0003') return finish(fail('mailbox_input_cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/^\d$/.test(char) && value.length < 8) value += char;
      }
    };
    const timer = setTimeout(() => finish(fail('mailbox_input_expired')), 120_000);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireProof(process.argv.length === 6 && process.argv[2] === '--approved-packet' && process.argv[4] === '--private-recovery', 'invalid_arguments');
    const packet = protectedJson(process.argv[3]), recoveryPath = process.argv[5];
    requireProof(packet.mode === 'operator-mailbox' && isAbsolute(recoveryPath), 'invalid_packet');
    const receipt = await runAccountTestJourney({ packet, readCode: mailboxCode,
      saveRecovery: state => {
        const fd = openSync(recoveryPath, 'wx', 0o600);
        try { writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
        const directory = openSync(dirname(recoveryPath), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      },
      clearRecovery: () => unlinkSync(recoveryPath) });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    // Fixed codes only. Never print exceptions, packet fields, cookies or codes.
    process.stderr.write(`Account test journey failed: ${/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'journey_failed'}.\n`);
    process.exitCode = 1;
  }
}
