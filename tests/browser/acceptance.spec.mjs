// Explicit real-service journey. Employer navigation stops at the reviewed destination.
import { test, expect } from '@playwright/test';
import { loadGateConfig, requireInvite, preflight, verifyCandidateBuilds, verifyPolicyState, verifyDisposableAccountAccess, GATE_LOCALES, disposableAccount, ownSession, cleanupCandidateAccount } from './release-gate.mjs';
import { verifyPublicFootprint } from './release-footprint.mjs';
import { accountStreamUrl, openReleaseStream, verifyReleaseStreamReconnect } from './release-live-results.mjs';
import { exerciseReleaseReadingState, saveReleaseInterfaceLanguage, verifyReleaseReadingState } from './release-reading-preferences.mjs';

for (const locale of GATE_LOCALES) {
  test(`${locale} fixed deployed candidate completes its disposable-account search and request journey`, async ({ browser }) => {
    test.setTimeout(240_000);
    const config = loadGateConfig(process.env.JUSTUP_ACCEPTANCE_CONFIG);
    const invite = requireInvite(process.env.JUSTUP_ACCEPTANCE_INVITE);
    const account = disposableAccount();
    const prefix = locale === 'en' ? '' : `/${locale}`;
    const context = await browser.newContext({ baseURL: config.origin, viewport: { width: 1280, height: 1100 }, locale, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    let stage = 'read-only preflight', failedStage = null, cleanupFailed = false;
    const read = async (path, presentation) => {
      // Explicit route presentation is request-only; preflight never writes a preference cookie.
      const headers = path.startsWith('/api/') ? { 'X-Justup-Locale': presentation?.locale ?? locale } : undefined;
      const response = await context.request.get(path, { timeout: 10_000, maxRedirects: 0, headers });
      const bytes = await response.body();
      if (bytes.length > 1_048_576 || !/noindex/.test(response.headers()['x-robots-tag'] ?? '')) throw new Error('Invalid public response boundary.');
      if (path.startsWith('/api/') && !/no-store/.test(response.headers()['cache-control'] ?? '')) throw new Error('Private API response was cacheable.');
      let json;
      if (path.startsWith('/api/') || path === '/__release/version') json = JSON.parse(bytes.toString('utf8'));
      return { status: response.status(), json, bytes };
    };
    const mutation = async (path, body, csrf) => {
      const response = await context.request.fetch(path, { method: path === '/api/v1/account' ? 'DELETE' : 'POST',
        headers: { Origin: config.origin, 'X-CSRF-Token': csrf, 'X-Justup-Locale': locale }, data: body, timeout: 10_000, maxRedirects: 0 });
      return { status: response.status(), json: await response.json() };
    };
    const session = async () => (await read('/api/v1/session')).json;
    const identity = () => verifyCandidateBuilds(config, read);
    const admission = async () => {
      await identity();
      verifyPolicyState(config, (await session()).policies, locale);
    };
    const responseFor = (method, path) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path, { timeout: 15_000 });
    const relogin = async () => {
      await page.locator('#account-open').click();
      await page.locator('#logout').click();
      await expect(page.locator('#header-sign-in')).toBeVisible();
      expect((await session()).user === null).toBe(true);
      if (locale === 'en') {
        const privateReads = await Promise.all(['/follows', '/workspace', '/preferences'].map(path => read(`/api/v1${path}`)));
        expect(privateReads.every(response => response.status === 401)).toBe(true);
      }
      await page.locator('#header-sign-in').click();
      await page.locator('#auth-username').fill(account.username);
      await page.locator('#auth-password').fill(account.password);
      await page.locator('#auth-submit').click();
      await expect(page.locator('#sign-in-dialog')).not.toBeVisible();
      expect(ownSession(await session(), account)).toBe(true);
    };
    try {
      await preflight(config, read);
      if (locale === 'en') {
        stage = 'public hiring footprint';
        await verifyPublicFootprint(browser, page, config);
      }
      stage = 'disposable account registration';
      await page.goto(`${prefix}/`);
      await page.locator('#header-sign-in').click();
      await page.locator('#auth-register').check();
      await page.locator('#auth-username').fill(account.username);
      await page.locator('#auth-password').fill(account.password);
      await page.locator('#auth-invite').fill(invite);
      await admission();
      account.attempted = true;
      const registering = responseFor('POST', '/api/v1/auth/register');
      await page.locator('#auth-submit').click();
      const registered = await registering;
      if (registered.status() >= 400 && registered.status() < 500) account.attempted = false;
      expect(registered.status() === 201).toBe(true);
      const registeredSession = await registered.json();
      expect(ownSession(registeredSession, account)).toBe(true);
      account.id = registeredSession.user.id;
      verifyPolicyState(config, registeredSession.policies, locale);
      const billing = config.billingMode === 'stripe_test' ? await read('/api/v1/account/billing') : undefined;
      verifyDisposableAccountAccess(config, registeredSession, billing);
      await expect(page.locator('#sign-in-dialog')).not.toBeVisible();

      if (locale !== 'en') {
        stage = 'logout and login';
        await relogin();
      }

      stage = 'real interpreted search and source';
      await page.locator('#query').fill(config.scenario.query);
      const submitSearch = () => page.locator('#job-search button[type=submit]').click();
      const opening = locale === 'en' ? await openReleaseStream(page, config.origin, submitSearch) : null;
      if (opening === null) await submitSearch();
      await page.locator('#search-results').waitFor({ state: 'visible', timeout: 90_000 });
      await page.locator('#search-results').scrollIntoViewIfNeeded();
      await expect.poll(async () => page.locator('a.posting-link').evaluateAll((links, expected) => links.some(link => link.href === expected), config.scenario.sourceUrl), { timeout: 15_000 }).toBe(true);
      const firstSearches = (await read('/api/v1/searches')).json?.items;
      expect(Array.isArray(firstSearches) && firstSearches.length === 1 && firstSearches[0].status === 'ready' && firstSearches[0].query === config.scenario.query).toBe(true);
      let accepted = firstSearches[0], reading;
      expect(await page.locator('[data-job]').evaluateAll((rows, expected) => rows.some(row => {
        const posting = row.querySelector('a.posting-link'), company = row.querySelector('a.job-company');
        const prefix = expected.locale === 'en' ? '' : `/${expected.locale}`;
        return posting?.href === expected.sourceUrl && company?.getAttribute('href') === `${prefix}/companies/${encodeURIComponent(expected.companyId)}`;
      }), { ...config.scenario, locale })).toBe(true);
      if (opening !== null) {
        stage = 'deployed live results reconnect';
        const timings = await verifyReleaseStreamReconnect(page, config.origin, opening, accepted, config.scenario.sourceUrl);
        console.log(JSON.stringify({ liveResults: timings }));
        stage = 'posting language and viewed position';
        reading = await exerciseReleaseReadingState(page, read, accepted, config.scenario.sourceUrl);
        accepted = reading.search;
      }

      stage = 'warned edit and explicit confirmation';
      await page.locator('#query').fill(config.scenario.warnedQuery);
      await page.locator('#job-search button[type=submit]').click();
      await page.locator('#confirm-search-proposal').waitFor({ state: 'visible', timeout: 90_000 });
      expect(await page.locator('a.posting-link').evaluateAll((links, expected) => links.some(link => link.href === expected), config.scenario.sourceUrl)).toBe(true);
      const preserved = (await read('/api/v1/searches')).json?.items?.find(search => search.id === accepted.id);
      expect(preserved?.revision === accepted.revision && preserved?.query === accepted.query).toBe(true);
      const confirming = responseFor('POST', `/api/v1/searches/${encodeURIComponent(accepted.id)}/confirm`);
      await page.locator('#confirm-search-proposal').click();
      expect((await confirming).status() === 200).toBe(true);
      const confirmed = (await read('/api/v1/searches')).json?.items?.find(search => search.id === accepted.id);
      expect(confirmed?.revision === accepted.revision + 1 && confirmed?.query === config.scenario.warnedQuery).toBe(true);

      stage = 'known company exact confirmation';
      await admission();
      await page.goto(`${prefix}/#request`);
      await page.locator('#request-query').fill(config.scenario.companyName);
      const requesting = responseFor('POST', '/api/v1/company-requests');
      await page.locator('#request-form button[type=submit]').click();
      const requested = await requesting;
      expect(requested.status() === 201).toBe(true);
      const candidate = (await requested.json()).request;
      expect(candidate?.status === 'candidate' && candidate.taskId === null && candidate.candidate?.coverage?.state === 'imported_snapshot'
        && candidate.candidate?.name === config.scenario.companyName && candidate.candidate.companyId === config.scenario.companyId).toBe(true);
      await page.locator('#accept-company').waitFor({ state: 'visible' });
      const accepting = responseFor('POST', `/api/v1/company-requests/${encodeURIComponent(candidate.id)}/accept`);
      await page.locator('#accept-company').click();
      const acceptedRequest = await accepting;
      const exact = acceptedRequest.request().postDataJSON();
      expect(exact.candidateId === candidate.candidate.id && exact.previewRevision === candidate.previewRevision).toBe(true);
      const published = (await acceptedRequest.json()).request;
      expect(acceptedRequest.status() === 200 && published?.status === 'accepted'
        && published.companyId === config.scenario.companyId).toBe(true);
      await expect(page.locator(`#request-content a[href="${prefix}/companies/${encodeURIComponent(published.companyId)}"]`)).toBeVisible();

      if (reading) {
        stage = 'reading preferences after sign-in';
        await admission();
        const french = await read('/api/v1/session', { locale: 'fr' });
        expect(french.status).toBe(200);
        verifyPolicyState(config, french.json.policies, 'fr');
        await page.goto('/');
        await saveReleaseInterfaceLanguage(page, read, account.id);
        await relogin();
        await page.goto('/');
        await verifyReleaseReadingState(page, read, { accountId: account.id, companyId: config.scenario.companyId, search: confirmed, reading });
      }

      stage = 'wrong password preserves account';
      await page.locator('#account-open').click();
      await page.locator('#delete-account').click();
      await page.locator('#delete-password').fill(`${account.password}wrong`);
      const wrongDelete = responseFor('DELETE', '/api/v1/account');
      await page.locator('#confirm-delete-account').click();
      const denied = await wrongDelete;
      expect(denied.status() === 401 && (await denied.json()).error?.code === 'invalid_credentials').toBe(true);
      expect(ownSession(await session(), account)).toBe(true);

      stage = 'own-account deletion and private access revocation';
      await page.locator('#delete-password').fill(account.password);
      const deleting = responseFor('DELETE', '/api/v1/account');
      await page.locator('#confirm-delete-account').click();
      expect((await deleting).status() === 200).toBe(true);
      await expect(page.locator('#header-sign-in')).toBeVisible();
      const guest = await session();
      expect(guest.user === null).toBe(true);
      expect((await read('/api/v1/searches')).status === 401).toBe(true);
      if (opening !== null) expect((await read(accountStreamUrl(confirmed))).status === 401).toBe(true);
      const absent = await mutation('/api/v1/auth/login', { username: account.username, password: account.password }, guest.csrfToken);
      expect(absent.status === 401 && absent.json.error?.code === 'invalid_credentials').toBe(true);
      account.deleted = true;
      stage = 'final fixed identity';
      await admission();
    } catch {
      // Playwright call logs can contain fill values; emit only this fixed stage label.
      failedStage = stage;
    } finally {
      try {
        if (account.attempted && !account.deleted) {
          await cleanupCandidateAccount(config, account, {
            read, session,
            login: (username, password, csrf) => mutation('/api/v1/auth/login', { username, password }, csrf),
            remove: async (password, csrf) => (await mutation('/api/v1/account', { password }, csrf)).status,
          });
        }
      } catch { cleanupFailed = true; }
      try { await context.close(); } catch { cleanupFailed = true; }
    }
    if (failedStage || cleanupFailed) throw new Error(`Deployed acceptance failed at ${failedStage ?? 'cleanup'}${cleanupFailed ? '; disposable-account cleanup needs private operator verification' : ''}.`);
  });
}
