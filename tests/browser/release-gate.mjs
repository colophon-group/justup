// Fixed-candidate preflight and disposable-account ownership for the explicit live gate.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
const plain = (value, max = 200) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const GATE_LOCALES = Object.freeze(['en', 'de', 'fr', 'it', 'es']);
const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const policyVersion = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
const hash = (value, length = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function origin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}
function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && value.length <= 2000;
  } catch { return false; }
}
export function validateGateConfig(value) {
  requireThat(record(value) && origin(value.origin), 'Set one fixed HTTPS acceptance origin.');
  const f = value.frontend, api = value.api, policies = value.policies, scenario = value.scenario;
  requireThat(record(f) && f.deploymentMode === 'preview' && ['sourceSha', 'treeSha'].every(key => hash(f[key], 40))
    && ['assetsSha256', 'workerSha256', 'artifactSha256', 'runtimeConfigSha256'].every(key => hash(f[key])), 'Supply exact frontend identities.');
  requireThat(record(api) && api.sourceCommit === f.sourceSha && api.schemaVersion === 1
    && plain(api.buildIdentity) && /^[A-Za-z0-9_.:-]{1,128}$/.test(api.runnerIdentity ?? '')
    && /^[a-f0-9-]{36}$/.test(api.importGeneration ?? ''), 'Supply compatible API, runner and import identities.');
  validatePolicyEvidence(policies, value.origin);
  requireThat(record(scenario) && plain(scenario.query, 2000) && plain(scenario.warnedQuery, 2000)
    && scenario.query !== scenario.warnedQuery && plain(scenario.companyId)
    && plain(scenario.companyName, 100) && sourceUrl(scenario.sourceUrl), 'Supply a reviewed real-source acceptance scenario.');
  return value;
}
// The declared map is release evidence, not a way to approve notices or configure the API.
function validatePolicyEvidence(policies, candidateOrigin) {
  requireThat(exactKeys(policies, ['admittedLocales', 'fallbackApprovals'])
    && record(policies.admittedLocales) && record(policies.fallbackApprovals), 'Supply the admitted locale policy map and explicit fallback approvals.');
  const entries = Object.entries(policies.admittedLocales);
  requireThat(entries.length === GATE_LOCALES.length && GATE_LOCALES.every(locale => Object.hasOwn(policies.admittedLocales, locale)), 'Full acceptance requires policy evidence for all five interface locales.');
  const fields = ['locale', 'reviewed', 'reviewedLocale', 'fallback', 'version', 'privacyUrl', 'usageUrl', 'privacySha256', 'usageSha256'];
  for (const [locale, entry] of entries) {
    requireThat(GATE_LOCALES.includes(locale) && exactKeys(entry, fields) && entry.locale === locale
      && entry.reviewed === true && GATE_LOCALES.includes(entry.reviewedLocale) && typeof entry.fallback === 'boolean'
      && entry.fallback === (entry.reviewedLocale !== locale) && policyVersion(entry.version)
      && hash(entry.privacySha256) && hash(entry.usageSha256), 'Admitted policy locale identity is missing or invalid.');
    const suffix = entry.reviewedLocale === 'en' ? '' : `.${entry.reviewedLocale}`;
    for (const kind of ['privacy', 'usage']) requireThat(entry[`${kind}Url`] === `${candidateOrigin}/${kind}${suffix}.html`, 'Policy URL is not the fixed reviewed-locale route.');
    const approval = policies.fallbackApprovals[locale];
    if (!entry.fallback) {
      requireThat(approval === undefined, 'A directly reviewed locale must not claim fallback approval.');
      continue;
    }
    const target = policies.admittedLocales[entry.reviewedLocale];
    requireThat(exactKeys(approval, ['reviewedLocale', 'version', 'operatorApproved']) && approval.operatorApproved === true
      && approval.reviewedLocale === entry.reviewedLocale && approval.version === entry.version
      && target?.reviewed === true && target.locale === entry.reviewedLocale && target.reviewedLocale === target.locale && target.fallback === false
      && ['version', 'privacyUrl', 'usageUrl', 'privacySha256', 'usageSha256'].every(key => target[key] === entry[key]), 'Fallback lacks explicit matching operator-approved target evidence.');
  }
  for (const locale of Object.keys(policies.fallbackApprovals)) requireThat(GATE_LOCALES.includes(locale)
    && policies.admittedLocales[locale]?.fallback === true, 'Fallback approval is outside the declared admitted locales.');
}
// JSON.parse silently accepts repeated object keys. Never discard a conflicting locale approval.
function rejectDuplicateKeys(text) {
  const stack = [];
  for (const token of text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) ?? []) {
    const current = stack.at(-1);
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (current) current.expectingKey = true; }
    else if (token.startsWith('"') && current?.expectingKey) {
      const key = JSON.parse(token);
      requireThat(!current.keys.has(key), 'Repeated acceptance configuration key.');
      current.keys.add(key); current.expectingKey = false;
    }
  }
}
export function loadGateConfig(path) {
  try {
    requireThat(typeof path === 'string' && isAbsolute(path), 'Invalid acceptance configuration.');
    const stat = lstatSync(path);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16_384, 'Invalid acceptance configuration.');
    const text = readFileSync(path, 'utf8');
    const config = JSON.parse(text);
    rejectDuplicateKeys(text);
    return validateGateConfig(config);
  } catch { throw new Error('Acceptance configuration is missing or invalid; no live journey started.'); }
}
export function requireInvite(value) {
  requireThat(plain(value, 256), 'Supply the preview invitation through the protected process environment.');
  return value;
}
const same = (a, b, keys) => record(a) && keys.every(key => a[key] === b[key]);
function freshCoverage(value, now) {
  return record(value) && value.kind === 'imported_snapshot' && value.stale === false
    && typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt))
    && Date.parse(value.verifiedAt) <= now && now - Date.parse(value.verifiedAt) < 86_400_000;
}
export function verifyBuilds(config, frontend, api, health, now = Date.now()) {
  requireThat(same(frontend, config.frontend, Object.keys(config.frontend)), 'Frontend identity changed.');
  requireThat(same(api, config.api, ['sourceCommit', 'schemaVersion', 'buildIdentity', 'importGeneration']), 'API or import identity changed.');
  for (const runner of [api?.runner, health?.runner]) {
    requireThat(record(runner) && runner.ready === true && runner.identity === config.api.runnerIdentity
      && runner.sourceCommit === config.api.sourceCommit && runner.buildIdentity === config.api.buildIdentity
      && typeof runner.lastHeartbeat === 'string' && Number.isFinite(Date.parse(runner.lastHeartbeat))
      && Date.parse(runner.lastHeartbeat) <= now + 1000 && now - Date.parse(runner.lastHeartbeat) < 30_000, 'Runner identity or readiness changed.');
  }
  requireThat(health?.ready === true && freshCoverage(health.coverage, now), 'A fresh, ready imported source is required.');
}
// Build safety and policy admission are separate: owned-account deletion remains
// available when policy approval is withdrawn, but never against another candidate.
export async function verifyCandidateBuilds(config, get, now = Date.now) {
  const frontend = await get('/__release/version');
  const api = await get('/api/v1/version');
  const health = await get('/api/v1/health');
  requireThat([frontend, api, health].every(response => response?.status === 200), 'Candidate identity HTTP status failed.');
  verifyBuilds(config, frontend.json, api.json, health.json, typeof now === 'function' ? now() : now);
}
// These seven fields are the authoritative server locale policy-state contract.
const POLICY_STATE_FIELDS = ['locale', 'reviewed', 'reviewedLocale', 'fallback', 'version', 'privacyUrl', 'usageUrl'];
export function verifyPolicyState(config, state, locale) {
  const expected = config.policies.admittedLocales[locale];
  requireThat(expected && exactKeys(state, POLICY_STATE_FIELDS)
    && POLICY_STATE_FIELDS.every(field => state[field] === expected[field]), 'Selected locale policy review, URLs, version or fallback changed.');
}
function attributes(tag) {
  const values = new Map();
  for (const match of tag.matchAll(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1].toLowerCase();
    requireThat(!values.has(key), 'Policy contains duplicate identity attributes.');
    values.set(key, match[2] ?? match[3]);
  }
  return values;
}
function verifyPolicyDocument(bytes, entry, kind) {
  requireThat(bytes instanceof Uint8Array && bytes.byteLength <= 1_048_576
    && createHash('sha256').update(bytes).digest('hex') === entry[`${kind}Sha256`], 'Reviewed policy bytes changed.');
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const oneTag = name => {
    const tags = [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))];
    requireThat(tags.length === 1, 'Policy identity tag is missing or repeated.');
    return attributes(tags[0][0]);
  };
  requireThat(oneTag('html').get('lang') === entry.reviewedLocale, 'Policy document language differs from the reviewed locale.');
  const body = oneTag('body');
  requireThat(body.get('data-policy') === kind && body.get('data-policy-version') === entry.version
    && body.get('data-policy-status') === 'approved' && body.get('data-policy-reviewed') === 'true', 'Policy document is unreviewed or has a different identity.');
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]));
  for (const [name, value] of [['justup-policy-version', entry.version], ['justup-policy-status', 'approved'], ['justup-policy-reviewed', 'true']]) {
    const found = metas.filter(meta => meta.get('name') === name);
    requireThat(found.length === 1 && found[0].get('content') === value, 'Policy metadata is unreviewed, missing or inconsistent.');
  }
}
export async function preflight(config, get, now = Date.now) {
  validateGateConfig(config);
  const clock = typeof now === 'function' ? now : () => now;
  const read = async (path, status = 200, locale) => {
    const result = await get(path, locale === undefined ? undefined : { locale });
    requireThat(result.status === status, 'Preview preflight HTTP status failed.');
    return result;
  };
  await verifyCandidateBuilds(config, read, clock);
  const verifiedDocuments = new Set();
  // Complete every declared locale's read-only policy proof before private work is allowed.
  for (const [locale, entry] of Object.entries(config.policies.admittedLocales)) {
    const s = (await read('/api/v1/session', 200, locale)).json;
    requireThat(s?.user === null && s.access?.fullAccess === false && s.access?.billingEnabled === false
      && s.authentication?.method === 'username_password' && s.authentication.loginEnabled === true
      && s.authentication.registrationEnabled === true && freshCoverage(s.coverage, clock())
      && s.capabilities?.search === true && s.capabilities.companyRequests === true, 'Preview authentication, capabilities or coverage are not ready for an admitted locale.');
    verifyPolicyState(config, s.policies, locale);
    const serverTime = Date.parse(s.serverTime);
    requireThat(Number.isFinite(serverTime) && Math.abs(serverTime - clock()) < 30_000, 'Preview server time is unavailable or out of range.');
    for (const kind of ['privacy', 'usage']) {
      const url = entry[`${kind}Url`];
      if (verifiedDocuments.has(url)) continue;
      const policy = await read(new URL(url).pathname);
      verifyPolicyDocument(policy.bytes, entry, kind);
      verifiedDocuments.add(url);
    }
  }
  const privateResponse = await read('/api/v1/searches', 401);
  requireThat(privateResponse.json?.error?.code === 'unauthenticated', 'Signed-out private access was not denied.');
  const publicFeed = (await read('/api/v1/jobs?limit=12')).json;
  const asOf = Date.parse(publicFeed?.asOf);
  requireThat(Number.isFinite(asOf) && Math.abs(asOf - clock()) < 30_000
    && Array.isArray(publicFeed?.items) && freshCoverage(publicFeed.coverage, clock())
    && publicFeed.items.every(job => {
      const at = Date.parse(job.firstObserved);
      return Number.isFinite(at) && at <= asOf - 172_800_000 && at >= asOf - 1_209_600_000;
    }), 'Visitor result access or freshness bounds failed.');
  const companies = (await read(`/api/v1/companies?q=${encodeURIComponent(config.scenario.companyName)}`)).json?.items;
  const exact = Array.isArray(companies) ? companies.filter(company => company.name?.normalize('NFKC').trim().toLowerCase() === config.scenario.companyName.normalize('NFKC').trim().toLowerCase()) : [];
  requireThat(exact.length === 1 && exact[0].id === config.scenario.companyId
    && exact[0].coverage?.state === 'imported_snapshot', 'The selected company is not an unambiguous imported identity.');
}
export function disposableAccount() {
  return { username: `gate_${randomBytes(12).toString('hex')}`, password: randomBytes(32).toString('base64url'), id: null, attempted: false, deleted: false };
}
export function ownSession(session, account) {
  return Boolean(session?.user && session.user.username === account.username && plain(session.user.id)
    && (account.id === null || account.id === session.user.id));
}
// Finally-only cleanup preserves the exact candidate and own-account checks, not
// admission to new processing. No policy check belongs before this deletion attempt.
export async function cleanupCandidateAccount(config, account, api, now = Date.now) {
  if (!account.attempted || account.deleted) return;
  await verifyCandidateBuilds(config, api.read, now);
  await cleanupAccount(account, api);
}
// Cleanup receives only this run's generated credentials, and refuses foreign sessions.
export async function cleanupAccount(account, api) {
  if (!account.attempted || account.deleted) return;
  let session = await api.session();
  requireThat(session?.user == null || ownSession(session, account), 'Cleanup refused an unrelated session.');
  if (!session?.user) {
    const result = await api.login(account.username, account.password, session.csrfToken);
    requireThat(result.status === 200, 'Disposable-account cleanup login failed.');
    session = result.json;
  }
  requireThat(ownSession(session, account), 'Cleanup refused an unrelated account.');
  account.id = session.user.id;
  requireThat(await api.remove(account.password, session.csrfToken) === 200, 'Disposable-account cleanup failed.');
  const guest = await api.session();
  requireThat(guest?.user === null, 'Disposable-account cleanup was not confirmed.');
  requireThat((await api.login(account.username, account.password, guest.csrfToken)).status === 401, 'Disposable-account deletion was not confirmed.');
  account.deleted = true;
}
