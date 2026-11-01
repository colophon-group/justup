// Same-origin application HTTP boundary. All mutation, cookie, policy and private route
// checks are centralized here before feature service code receives a request.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { POLICY_LOCALES,policyState,policyScopes,requestLocale,validatePolicyConfig } from './policies.mjs';
import { problem, boundedJson } from './store.mjs';

const DISABLED = { sse: false };
const GUEST_ACCESS = { kind: 'guest', fullAccess: false, legacy: false, billingEnabled: false, until: null };
const SAFE_ERRORS = new Map([
  ['invalid_input', 'Invalid request.'], ['invalid_credentials', 'Invalid username, password or invite code.'],
  ['registration_closed', 'Registration is closed.'], ['account_limit', 'The account limit has been reached.'],
  ['username_taken', 'That username is unavailable.'], ['unauthenticated', 'Sign in to continue.'],
  ['policy_unavailable', 'Processing is unavailable until policies are approved for this language.'],
  ['deletion_unavailable', 'Account access is temporarily unavailable.'],
  ['forbidden', 'This request is not allowed.'], ['invalid_json', 'Send a bounded JSON object.'],
  ['identity_unverified','Verify your account to activate the free period.'], ['free_period_unavailable','The free period is unavailable.'],
  ['not_found', 'Not found.'], ['rate_limit', 'Too many requests. Try again later.'],
  ['task_limit', 'The task limit has been reached.'], ['idempotency_conflict', 'This request key was already used.'],
  ['stale_cursor', 'This feed changed. Reload it and try again.'], ['invalid_cursor', 'Invalid cursor.'],
  ['invalid_limit', 'Invalid page size.'], ['invalid_query', 'Invalid query.'],
  ['dependency_unavailable', 'This feature is temporarily unavailable.'],
  ['revision_conflict', 'This search changed. Reload it and try again.'],
  ['preview_conflict', 'This preview changed. Reload it and try again.'],
  ['unsupported_requirements', 'Some requirements are unsupported.'],
]);
export {policyState} from './policies.mjs';
function decodePath(value) { try { return decodeURIComponent(value); } catch { throw problem('invalid_input'); } }
function cookies(header) {
  const result = {};
  if (typeof header !== 'string' || header.length > 8192) return result;
  for (const entry of header.split(';')) {
    const [name, value, ...rest] = entry.trim().split('=');
    if (!rest.length && /^[A-Za-z0-9_-]{43}$/.test(value ?? '') && !(name in result)) result[name] = value;
  }
  return result;
}
async function readBody(req, maxBytes) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw problem('invalid_json');
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw problem('invalid_json');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw problem('invalid_json');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw problem('invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('invalid_json');
  return body;
}
export function createHandler({ auth, feed, tasks, db, services = [], config = {}, policyConfig=config, now = Date.now, logger = () => {}, afterPrivateTransaction = () => {} }) {
  validatePolicyConfig(policyConfig);
  const origin = new URL(config.allowedOrigin ?? 'https://preview.justup.work');
  const insecure = config.allowInsecureLocalhost === true && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== (config.allowedOrigin ?? 'https://preview.justup.work') || (!insecure && origin.protocol !== 'https:')) throw new TypeError('Set one allowed HTTPS browser origin.');
  const cookieName = insecure ? 'justup_session' : '__Host-justup_session';
  const visitorCookie = insecure ? 'justup_visitor' : '__Host-justup_visitor';
  const visitorService=services.find(service=>typeof service.visitorRoute==='function');
  const liveResults=services.find(service=>typeof service.openStream==='function');
  const csrfCookie = insecure ? 'justup_csrf' : '__Host-justup_csrf';
  const secret = config.csrfSecret ?? randomBytes(32);
  if (Buffer.byteLength(secret) < 32) throw new TypeError('CSRF secret must contain at least 32 bytes.');
  const maxBodyBytes = config.maxBodyBytes ?? 16_384;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65_536) throw new TypeError('Invalid body limit.');
  const policies = (locale='en') => policyState(policyConfig,locale), buckets = new Map();
  function authentication(locale) {
    const reason = !policies(locale).reviewed ? 'policy_unavailable'
      : config.deletionReady?.() === false ? 'deletion_unavailable'
      : typeof auth.cleanup !== 'function' || config.authMaintenanceReady?.() === false ? 'dependency_unavailable' : null;
    const requiresInvitation = config.requiresInvitation !== false;
    const registration = typeof auth.registrationState === 'function' ? auth.registrationState() : { enabled: false, reason: 'registration_closed' };
    return { loginEnabled: reason == null, registrationEnabled: reason == null && registration.enabled, requiresInvitation,
      method: 'username_password', reason, registrationReason: reason ?? registration.reason ?? null };
  }
  const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
  const digest = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const visitorHint = (seed,epoch) => digest(`visitor-owner:${epoch}:${seed}`);
  const csrf = (token, guestToken) => digest(token ? `session:${token}` : `guest:${guestToken}`);
  const cookie = (name, value, expiresAt) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${insecure ? '' : '; Secure'}; Max-Age=${Math.max(0, Math.floor((expiresAt - now()) / 1000))}`;
  function limit(req, category) {
    const at = now(), windowMs = 60_000;
    // Use direct peer only. Reverse-proxy deployments must configure trusted
    // ingress rate limits rather than trusting a client-controlled forwarding header.
    const key = digest(`${category}:${req.socket.remoteAddress ?? 'unknown'}`);
    if (buckets.size >= 10_000) for (const [k, v] of buckets) if (v.until <= at) buckets.delete(k);
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= at) {
      if (!bucket && buckets.size >= 10_000) throw Object.assign(problem('rate_limit', 429), { retryAfter: 60 });
      bucket = { count: 0, until: at + windowMs }; buckets.set(key, bucket);
    }
    const ceiling = config.rateLimits?.[category] ?? (category === 'auth' ? 6 : category === 'mutation' ? 30 : 120);
    if (++bucket.count > ceiling) throw Object.assign(problem('rate_limit', 429), { retryAfter: Math.max(1, Math.ceil((bucket.until - at) / 1000)) });
  }
  function capabilities(locale) {
    const result = { search: false, aiMatching: false, companyRequests: false, hiringWire: false };
    for (const service of services) Object.assign(result, typeof service.capabilities === 'function' ? service.capabilities() : service.capabilities);
    return { follows:false,preferences:false,viewed:false,hiddenMatchCounts:false,visitorSearch:false,...result, ...DISABLED,
      search:authentication(locale).loginEnabled&&result.search===true,aiMatching:authentication(locale).loginEnabled&&result.aiMatching===true,companyRequests:authentication(locale).loginEnabled&&result.companyRequests===true,
      sse:authentication(locale).loginEnabled&&result.sse===true,
      visitorSearch:policies(locale).reviewed&&config.deletionReady?.()!==false&&result.visitorSearch===true };
  }
  function sessionBody(viewer, token, guestToken, visitor=null,locale='en') {
    return { serverTime: new Date(now()).toISOString(), user: viewer?.account ?? null, expiresAt: viewer ? new Date(viewer.expiresAt).toISOString() : null,
      access: viewer?.access ?? GUEST_ACCESS, visitor:visitorService?.publicVisitor(visitor)??null, csrfToken: csrf(token, guestToken), capabilities: capabilities(locale),
      policies:policies(locale), authentication: authentication(locale), coverage: feed.coverage() };
  }
  return async function handler(req, res) {
    const requestId = randomUUID(), started = now(); let category = 'unknown';
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    const send = (status, body) => {
      const serialized = boundedJson(body, 1_048_576);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(serialized);
    };
    const finish = (status, body) => { afterPrivateTransaction(); return send(status, body); };
    try {
      const url = new URL(req.url, origin.origin);
      if (!url.pathname.startsWith('/api/v1/')) throw problem('not_found', 404);
      const path = url.pathname.slice('/api/v1'.length), method = req.method;
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw problem('not_found', 404);
      const explicitLocale=req.headers['x-justup-locale'];
      if(explicitLocale!==undefined&&(!POLICY_LOCALES.includes(explicitLocale)||(req.headersDistinct?.['x-justup-locale']?.length??1)!==1))throw problem('invalid_input');
      const parsedCookies = cookies(req.headers.cookie);
      const token = parsedCookies[cookieName] ?? null, viewer = token ? auth.session(token) : null;
      const sessionToken = viewer ? token : null;
      const readingPreferences=services.find(s=>typeof s.preferences==='function');
      const interfaceLocale=requestLocale({explicitLocale,cookie:req.headers.cookie,acceptLanguage:req.headers['accept-language'],savedLocale:viewer?readingPreferences?.preferences(viewer.account.id).interfaceLocale??null:undefined});
      let guestToken = parsedCookies[csrfCookie] ?? randomBytes(32).toString('base64url');
      const visitorToken=parsedCookies[visitorCookie]??null;
      const visitorRoute=Boolean(visitorService)&&/^\/visitor\/(?:searches(?:\/[^/]+(?:\/(?:confirm|results|options))?)?|search-options|tasks\/[^/]+|workspace(?:\/recovered-drafts\/[^/]+)?|viewed|session)$/.test(path);
      const authRoute = method === 'POST' && ['/auth/register', '/auth/login'].includes(path);
      const mutation = method !== 'GET';
      category = authRoute ? 'auth' : mutation ? 'mutation' : path === '/health' || path === '/version' ? 'health' : 'read';
      if (category !== 'health') limit(req, category);
      let body;
      if (mutation) {
        if (req.headers.origin !== origin.origin) throw problem('forbidden', 403);
        if (!authRoute && !viewer && !visitorRoute) throw problem('unauthenticated', 401);
        const supplied = req.headers['x-csrf-token'], expected = csrf(sessionToken, guestToken);
        if (typeof supplied !== 'string' || !tokenPattern.test(supplied)
            || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || (!viewer && !parsedCookies[csrfCookie])) throw problem('forbidden', 403);
        if (authRoute) {
          const state = authentication(interfaceLocale);
          if (!state.loginEnabled) throw problem(state.reason, 503);
          if (path === '/auth/register' && !state.registrationEnabled) throw problem(state.registrationReason ?? 'registration_closed', 403);
        }
        body = await readBody(req,method==='PATCH'&&['/workspace','/visitor/workspace'].includes(path)?65_536:maxBodyBytes);
        if(body.presentationLocale!==undefined&&body.presentationLocale!==interfaceLocale)throw problem('invalid_input');
      }
      if (method === 'GET' && path === '/session') {
        let visitor=null;
        if (!viewer) {
          if(visitorService&&policies(interfaceLocale).reviewed&&config.deletionReady?.()!==false)visitor=visitorService.currentSession(visitorToken,{locale:interfaceLocale});
          const epoch=visitorService?.issuanceEpoch();
          const retired=visitorService?.tokenRetired(visitorToken)||(epoch!=null&&visitorService?.tokenRetired(visitorHint(guestToken,epoch)));
          if(retired)guestToken=randomBytes(32).toString('base64url');
          const nextCookies=[cookie(csrfCookie, guestToken, now() + 3_600_000)];
          // This opaque ownership hint is stateless until an admitted search.
          // Keep live ownership across epoch changes; replace unknown hints only
          // here, never during a POST whose entire response could be lost.
          if(visitorService){const hint=visitorService.sessionExists(visitorToken)?visitorToken:epoch==null?null:visitorHint(guestToken,epoch);nextCookies.push(cookie(visitorCookie,hint??'',hint==null?now():visitor?.expiresAt??now()+86_400_000));}
          res.setHeader('Set-Cookie',nextCookies);
        }
        return finish(200, sessionBody(viewer, sessionToken, guestToken,visitor,interfaceLocale));
      }
      if (authRoute) {
        let visitorHandoff={status:'none'},handoffRan=!visitorToken||!visitorService;
        const afterAuthenticated=context=>{
          const locale=requestLocale({explicitLocale,cookie:req.headers.cookie,acceptLanguage:req.headers['accept-language'],savedLocale:readingPreferences?.preferences(context.accountId).interfaceLocale??null});
          const state=authentication(locale);if(!state.loginEnabled)throw problem(state.reason,503);
          if(visitorToken&&visitorService){handoffRan=true;visitorHandoff=visitorService.handoff(visitorToken,context);}
          return visitorHandoff;
        };
        const result = path === '/auth/register' ? await auth.register(body,{afterAuthenticated}) : await auth.login(body,{afterAuthenticated});
        const verifiedViewer=auth.session(result.token);
        if(!handoffRan)throw problem('dependency_unavailable',503);
        res.setHeader('Set-Cookie', [cookie(cookieName, result.token, result.expiresAt), cookie(csrfCookie, '', now()),cookie(visitorCookie,'',now())]);
        return finish(path === '/auth/register' ? 201 : 200, {...sessionBody(verifiedViewer, result.token, guestToken,null,requestLocale({explicitLocale,cookie:req.headers.cookie,acceptLanguage:req.headers['accept-language'],savedLocale:readingPreferences?.preferences(verifiedViewer.account.id).interfaceLocale??null})),visitorHandoff});
      }
      if(viewer&&mutation&&method!=='DELETE'&&path!=='/session/logout'){const state=authentication(interfaceLocale);if(!state.loginEnabled)throw problem(state.reason,503);}
      if(method==='POST'&&path==='/access/activate') {
        if(Object.keys(body).length)throw problem('invalid_input');
        if(typeof auth.activateFreePeriod!=='function')throw problem('dependency_unavailable',503);
        auth.activateFreePeriod(sessionToken);
        return finish(200,sessionBody(auth.session(sessionToken),sessionToken,guestToken,null,interfaceLocale));
      }
      if (method === 'POST' && path === '/session/logout') {
        auth.logout(token); res.setHeader('Set-Cookie', [cookie(cookieName, '', now()),cookie(visitorCookie,'',now()),cookie(csrfCookie,'',now())]);
        return finish(200, { loggedOut: true });
      }
      if (method === 'DELETE' && path === '/account') {
        const result = await auth.deleteAccount(token, body.password);
        res.setHeader('Set-Cookie', cookie(cookieName, '', now())); return finish(200, result);
      }
      if (method === 'GET' && path === '/jobs') {
        const rawLimit = url.searchParams.get('limit');
        const pageLimit = rawLimit == null ? 12 : /^\d{1,2}$/.test(rawLimit) ? Number(rawLimit) : NaN;
        return finish(200, feed.list({ viewer, cursor: url.searchParams.get('cursor'), limit: pageLimit }));
      }
      if (method === 'GET' && path === '/companies') {
        if ([...url.searchParams.keys()].some(key => !['q', 'limit', 'cursor'].includes(key))
            || ['q', 'limit', 'cursor'].some(key => url.searchParams.getAll(key).length > 1)) throw problem('invalid_query');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 20 : /^[1-9]\d?$/.test(rawLimit) ? Number(rawLimit) : NaN;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw problem('invalid_limit');
        return finish(200, feed.companies({ q: url.searchParams.get('q') ?? '', cursor: url.searchParams.get('cursor'), limit }));
      }
      if (method === 'GET' && /^\/companies\/[^/]+$/.test(path)) return finish(200, feed.company(decodePath(path.split('/')[2])));
      if (method === 'GET' && path === '/health') {
        const readiness = typeof config.readiness === 'function' ? config.readiness() : { ready: true, runner: { ready: false, identity: null } };
        return finish(readiness.ready ? 200 : 503, { ...readiness, coverage: feed.coverage() });
      }
      if (method === 'GET' && path === '/version') return finish(200, {
        sourceCommit: config.sourceCommit ?? null, schemaVersion: 1, buildIdentity: config.buildIdentity ?? null,
        runner: (typeof config.readiness === 'function' ? config.readiness().runner : null) ?? { ready: false, identity: null },
        importGeneration: feed.generation(),
      });
      if (method === 'GET' && ['/workspace/events','/visitor/workspace/events'].includes(path)) {
        if (!liveResults) throw problem('dependency_unavailable', 503);
        if ((req.headers.origin != null && req.headers.origin !== origin.origin)
            || (req.headers['sec-fetch-site'] != null && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) throw problem('forbidden', 403);
        const searchId = url.searchParams.get('searchId'), revisionInput = url.searchParams.get('revision');
        if (!['revision,searchId','locale,revision,searchId'].includes([...url.searchParams.keys()].sort().join(','))
            || typeof searchId !== 'string' || !searchId || searchId.length > 128
            || !/^[1-9][0-9]{0,8}$/.test(revisionInput ?? '')) throw problem('invalid_input');
        const queryLocale=url.searchParams.get('locale')??undefined;
        if(queryLocale!==undefined&&(!POLICY_LOCALES.includes(queryLocale)||explicitLocale!==undefined&&explicitLocale!==queryLocale))throw problem('invalid_input');
        const revision = Number(revisionInput);
        const anonymous = path.startsWith('/visitor/');
        let admittedPolicy=null;
        const readAuthority = () => {
          const current = token ? auth.session(token) : null;
          const locale=requestLocale({explicitLocale:queryLocale??explicitLocale,cookie:req.headers.cookie,acceptLanguage:req.headers['accept-language'],savedLocale:current?readingPreferences?.preferences(current.account.id).interfaceLocale??null:undefined});
          const state = authentication(locale);
          if (!state.loginEnabled) throw problem(state.reason, 503);
          const policy=JSON.stringify(policyScopes(policyConfig)[locale]);
          if(admittedPolicy!==null&&admittedPolicy!==policy)throw problem('policy_unavailable',503);
          admittedPolicy=policy;
          if (!anonymous) { if (!current) throw problem('unauthenticated',401); return {...current,interfaceLocale:locale}; }
          if (current) throw problem('forbidden',403);
          const principal = visitorService?.identity?.fromToken(visitorToken,{locale});
          if (!principal) throw problem('unauthenticated',401);
          return principal;
        };
        afterPrivateTransaction();
        readAuthority();
        liveResults.openStream({req,res,readAuthority,searchId,revision,authorityKey:digest(`${anonymous?'visitor':'session'}:${anonymous?visitorToken:token}:${admittedPolicy}`),
          lastEventId:req.headers['last-event-id']??null});
        return;
      }
      // Only explicit read-only public projections run without account ownership.
      // The fixed runtime composes these services; mutations never use this hook.
      if (method === 'GET') for (const service of services) {
        const result = await service.publicRoute?.({ method, path, url, viewer, accountId: viewer?.account.id ?? null, requestId, db });
        if (result != null) return finish(result.status ?? 200, result.body);
      }
      if(visitorRoute) {
        if(method!=='DELETE'){
          if(!policies(interfaceLocale).reviewed)throw problem('policy_unavailable',503);
          if(config.deletionReady?.()===false)throw problem('deletion_unavailable',503);
          if(config.authMaintenanceReady?.()===false)throw problem('dependency_unavailable',503);
        }
        let ownerToken=visitorToken,opened;
        if(method==='POST'&&path==='/visitor/searches'&&!viewer&&!visitorService.currentSession(ownerToken,{locale:interfaceLocale})){
          visitorService.admitCreation(body);
          const epoch=visitorService.issuanceEpoch();
          // Only the exact current pre-issued hint may become new ownership.
          // A stale/deleted/unknown cookie must bootstrap through GET /session.
          if(epoch==null||ownerToken!==visitorHint(guestToken,epoch)||visitorService.tokenRetired(ownerToken))throw problem('unauthenticated',401);
          opened=visitorService.openSession(ownerToken,{locale:interfaceLocale,issuanceEpoch:epoch});ownerToken=opened.token;
        }
        let result;
        try{result=await visitorService.visitorRoute({method,path,url,body,viewer,visitorToken:ownerToken,interfaceLocale,requestId,db});}
        catch(error){if(opened)visitorService.discardEmptySession(ownerToken);throw error;}
        if(opened)res.setHeader('Set-Cookie',cookie(visitorCookie,ownerToken,opened.principal.expiresAt));
        if(result!=null)return finish(result.status??200,result.body);
        throw problem('not_found',404);
      }
      if (!viewer) throw problem('unauthenticated', 401);
      if(method==='GET'&&/^\/searches\/[^/]+\/results$/.test(path)){const state=authentication(interfaceLocale);if(!state.loginEnabled)throw problem(state.reason,503);}
      const idempotencyKey = req.headers['idempotency-key'] ?? null;
      if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey))) throw problem('invalid_input');
      const ctx = { method, path, url, body, viewer, accountId: viewer.account.id, requestId, db, idempotencyKey,interfaceLocale };
      if (method === 'GET' && /^\/tasks\/[^/]+$/.test(path)) {
        const task = tasks.get(viewer.account.id, decodePath(path.split('/')[2]));
        if (!task) throw problem('not_found', 404);
        let output = null;
        for (const service of services) if (service.taskResult) {
          const candidate = await service.taskResult(task, ctx);
          if (candidate !== undefined) { output = candidate; break; }
        }
        return finish(200, tasks.publicView(task, output));
      }
      for (const service of services) {
        const result = await service.route?.(ctx);
        if (result != null) return finish(result.status ?? 200, result.body);
      }
      throw problem('not_found', 404);
    } catch (error) {
      const known = SAFE_ERRORS.has(error.code), status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (!res.headersSent) {
        if (status === 429 || status === 503) res.setHeader('Retry-After', String(Number.isInteger(error.retryAfter) ? Math.min(3600, Math.max(1, error.retryAfter)) : 60));
        send(status, { error: { code: known ? error.code : 'internal_error', message: known ? SAFE_ERRORS.get(error.code) : 'The request could not be completed.', requestId } });
      } else res.destroy();
    } finally {
      try { afterPrivateTransaction(); } catch { /* Retain unsafe pending state; never clear a foreign marker. */ }
      // Only approved metadata reaches diagnostics; exceptions, URLs, bodies,
      // tokens, usernames and IP addresses never reach this sink.
      try { logger({ requestId, category, status: res.statusCode, durationMs: Math.max(0, now() - started) }); } catch { /* Logging cannot change request behavior. */ }
    }
  };
}
