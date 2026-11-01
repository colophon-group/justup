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
  requireThat(record(policies) && plain(policies.version, 100)
    && hash(policies.privacySha256) && hash(policies.usageSha256), 'Supply reviewed policy identities.');
  requireThat(record(scenario) && plain(scenario.query, 2000) && plain(scenario.warnedQuery, 2000)
    && scenario.query !== scenario.warnedQuery && plain(scenario.companyId)
    && plain(scenario.companyName, 100) && sourceUrl(scenario.sourceUrl), 'Supply a reviewed real-source acceptance scenario.');
  return value;
}
export function loadGateConfig(path) {
  try {
    requireThat(typeof path === 'string' && isAbsolute(path), 'Invalid acceptance configuration.');
    const stat = lstatSync(path);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16_384, 'Invalid acceptance configuration.');
    return validateGateConfig(JSON.parse(readFileSync(path, 'utf8')));
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
export async function preflight(config, get, now = Date.now) {
  validateGateConfig(config);
  const clock = typeof now === 'function' ? now : () => now;
  const read = async (path, status = 200) => {
    const result = await get(path);
    requireThat(result.status === status, 'Preview preflight HTTP status failed.');
    return result;
  };
  const frontend = await read('/__release/version');
  const api = await read('/api/v1/version');
  const health = await read('/api/v1/health');
  verifyBuilds(config, frontend.json, api.json, health.json, clock());
  const session = await read('/api/v1/session');
  const s = session.json;
  requireThat(s?.user === null && s.access?.fullAccess === false && s.access?.billingEnabled === false
    && s.authentication?.method === 'username_password' && s.authentication.loginEnabled === true
    && s.authentication.registrationEnabled === true && s.policies?.reviewed === true
    && s.policies.version === config.policies.version && freshCoverage(s.coverage, clock())
    && s.capabilities?.search === true && s.capabilities.companyRequests === true, 'Preview authentication, policies, capabilities or coverage are not ready.');
  const serverTime = Date.parse(s.serverTime);
  requireThat(Number.isFinite(serverTime) && Math.abs(serverTime - clock()) < 30_000, 'Preview server time is unavailable or out of range.');
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
  for (const [field, path, expected] of [['privacyUrl', '/privacy.html', config.policies.privacySha256], ['usageUrl', '/usage.html', config.policies.usageSha256]]) {
    requireThat(s.policies[field] === `${config.origin}${path}`, 'Policy URL is not the fixed public policy route.');
    const policy = await read(path);
    requireThat(createHash('sha256').update(policy.bytes).digest('hex') === expected, 'Reviewed policy bytes changed.');
  }
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
