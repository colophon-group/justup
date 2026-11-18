// Explicit preview journey using an existing disposable account and a scheduled import.
import { test } from '@playwright/test';
import { loadGateConfig, observeCandidateImport, ownSession, requireLiveArrivalAccount, verifyCandidateBuilds, verifyPolicyState } from './release-gate.mjs';
import { openReleaseStream, verifyReleaseFeedArrival } from './release-live-results.mjs';

test('the fixed preview delivers a newly observed job without moving the reader', async ({ browser }) => {
  test.setTimeout(225_000);
  const config = loadGateConfig(process.env.JUSTUP_ACCEPTANCE_CONFIG);
  const account = requireLiveArrivalAccount(config, process.env);
  const context = await browser.newContext({ baseURL: config.origin, viewport: { width: 1280, height: 900 }, locale: 'en', reducedMotion: 'reduce' });
  let stage = 'candidate and account admission', failedStage, attemptedLogin = false, cleanupFailed = false, evidence;
  const request = async (path, options) => {
    const response = await context.request.fetch(path, { timeout: 10_000, maxRedirects: 0, ...options,
      headers: { 'X-Justup-Locale': 'en', ...options?.headers } });
    const body = await response.body(), headers = response.headers();
    if (body.length > 1_048_576 || !/\bnoindex\b/.test(headers['x-robots-tag'] ?? '')
      || path.startsWith('/api/') && !/\bno-store\b/.test(headers['cache-control'] ?? '')) throw new Error('Invalid preview response boundary.');
    return { status: response.status(), json: JSON.parse(body.toString('utf8')) };
  };
  const observe = () => observeCandidateImport(config, request);
  const readSession = async () => {
    const response = await request('/api/v1/session');
    if (response.status !== 200) throw new Error('Preview session is unavailable.');
    return response.json;
  };
  const changeSession = (path, data, csrf) => request(path, { method: 'POST', data,
    headers: { Origin: config.origin, 'X-CSRF-Token': csrf } });
  const admittedAccount = async () => {
    const session = await readSession();
    verifyPolicyState(config, session.policies, 'en');
    if (!ownSession(session, account) || session.access?.fullAccess !== true || session.capabilities?.sse !== true) {
      throw new Error('The dedicated account needs current full access and live results.');
    }
  };
  const savedSearch = async () => {
    const response = await request('/api/v1/searches'), searches = response.json?.items;
    const search = Array.isArray(searches) && searches.length === 1 ? searches[0] : null;
    if (response.status !== 200 || search?.status !== 'ready' || search.query !== config.scenario.query
      || search.configuration?.residualAi !== null || search.draft != null) throw new Error('The reviewed primary-only saved search is unavailable.');
    return search;
  };
  try {
    await verifyCandidateBuilds(config, request);
    const guest = await readSession();
    verifyPolicyState(config, guest.policies, 'en');
    if (guest.user !== null || guest.authentication?.loginEnabled !== true) throw new Error('Expected a fresh preview guest session.');
    attemptedLogin = true;
    const login = await changeSession('/api/v1/auth/login', { username: account.username, password: account.password }, guest.csrfToken);
    if (login.status !== 200 || !ownSession(login.json, account)) throw new Error('Dedicated account login failed.');
    await admittedAccount();
    const search = await savedSearch();
    const workspace = await request('/api/v1/workspace');
    if (workspace.status !== 200 || workspace.json.state?.activeSearchId !== search.id) throw new Error('The reviewed search is not active in the saved workspace.');

    stage = 'scheduled feed arrival';
    const page = await context.newPage();
    const opening = await openReleaseStream(page, config.origin, async () => {
      const document = await page.goto('/');
      if (document?.url() !== `${config.origin}/` || document.request().redirectedFrom() !== null) throw new Error('Preview workspace redirected.');
    });
    evidence = await verifyReleaseFeedArrival(page, { opening, search, sourceUrl: config.scenario.sourceUrl,
      baselineGeneration: config.api.importGeneration, read: request, observeImport: observe });

    stage = 'final build, account and search identities';
    await admittedAccount();
    const current = await savedSearch();
    if (current.id !== search.id || current.revision !== search.revision || await observe() !== evidence.arrivalGeneration) {
      throw new Error('The verified import or active search changed before completion.');
    }
  } catch {
    failedStage = stage;
  } finally {
    try {
      if (attemptedLogin) {
        await observe();
        const session = await readSession();
        if (session.user !== null) {
          if (!ownSession(session, account)) throw new Error('Refused to sign out a foreign account.');
          const logout = await changeSession('/api/v1/session/logout', {}, session.csrfToken);
          if (logout.status !== 200 || (await readSession()).user !== null) throw new Error('The disposable session was not revoked.');
        }
      }
    } catch { cleanupFailed = true; }
    try { await context.close(); } catch { cleanupFailed = true; }
  }
  if (failedStage || cleanupFailed) throw new Error(`Live arrival verification failed at ${failedStage ?? 'cleanup'}.${cleanupFailed ? ' Session cleanup needs private operator verification.' : ''}`);
  console.log(JSON.stringify({ liveArrival: { ...evidence, sourceCommit: config.api.sourceCommit,
    frontendArtifactSha256: config.frontend.artifactSha256, apiBuildIdentity: config.api.buildIdentity,
    runnerIdentity: config.api.runnerIdentity } }));
});
