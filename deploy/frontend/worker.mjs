// Frontend edge boundary. Read when changing public routing, privacy headers or API streaming.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=86400',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an HTTPS origin');
  return url.origin;
}

// Only the incoming Cloudflare address is trusted here, before a subrequest can
// replace platform headers. The API authenticates these two private headers.
export function trustedIngressHeaders(request, env) {
  const secret = env.API_INGRESS_SECRET;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(secret)) throw new Error('Trusted ingress unavailable');
  const address = request.headers.get('CF-Connecting-IP');
  if (typeof address !== 'string' || address.length > 45 || !validClientAddress(address)) throw new Error('Trusted ingress unavailable');
  return new Headers({ 'X-Justup-Ingress': secret, 'X-Justup-Client-IP': address });
}

function validClientAddress(value) {
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return value.split('.').every(part => Number(part) <= 255);
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try { return new URL(`https://[${value}]/`).hostname.startsWith('['); } catch { return false; }
}

function response(body, status, headers = {}, privateResponse = false, indexable = false, publicRobots = null) {
  const result = new Headers(headers);
  result.delete('X-Justup-Ingress');
  result.delete('X-Justup-Client-IP');
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) result.set(key, value);
  if (indexable) result.delete('X-Robots-Tag');
  else result.set('X-Robots-Tag', publicRobots ?? 'noindex, nofollow, noarchive');
  result.set('Cache-Control', privateResponse ? 'private, no-store, max-age=0' : 'no-cache');
  result.set('CDN-Cache-Control', 'no-store');
  result.set('Cloudflare-CDN-Cache-Control', 'no-store');
  if (privateResponse) {
    result.delete('etag');
    result.delete('last-modified');
    result.set('Pragma', 'no-cache');
    result.set('Expires', '0');
  }
  return new Response(body, { status, headers: result });
}

function unavailable(code = 'dependency_unavailable', status = 503) {
  return response(JSON.stringify({ error: { code, message: status === 403 ? 'Request origin is not allowed.' : 'The service is unavailable.', requestId: crypto.randomUUID(), retryAfter: 30 } }), status, { 'Content-Type': 'application/json', 'Retry-After': '30' }, true);
}

export function createHandler(fetchUpstream = globalThis.fetch, renderPublicDocument) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const mode = env.DEPLOYMENT_MODE;
    if (!['preview', 'production'].includes(mode)) return unavailable('deployment_mode_unavailable');
    let publicOrigin;
    try { publicOrigin = httpsOrigin(env.PUBLIC_ORIGIN); } catch { return unavailable(); }
    // Do not expose the service through alternate workers.dev/version hostnames.
    if (url.origin !== publicOrigin) return unavailable('origin_not_allowed', 403);
    if (url.pathname === '/__release/version') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' }, true);
      try {
        const release = JSON.parse(env.RELEASE_JSON);
        const keys = ['sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256'];
        const identity = Object.fromEntries(keys.map(key => {
          if (!/^[a-f0-9]{40,64}$/.test(release[key])) throw new Error('Missing identity');
          return [key, release[key]];
        }));
        if (!/^[a-f0-9]{64}$/.test(env.RUNTIME_CONFIG_SHA256)) throw new Error('Missing config identity');
        return response(request.method === 'HEAD' ? null : JSON.stringify({ ...identity, runtimeConfigSha256: env.RUNTIME_CONFIG_SHA256, apiPrefix: '/api/v1', deploymentMode: mode }), 200, { 'Content-Type': 'application/json' }, true);
      } catch { return unavailable('release_identity_unavailable'); }
    }
    if (url.pathname === '/robots.txt') return response(mode === 'preview' ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /api/\nDisallow: /__release/\n', 200, { 'Content-Type': 'text/plain' }, false, mode === 'production');
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      let apiOrigin;
      try { apiOrigin = httpsOrigin(env.API_ORIGIN); } catch { return unavailable(); }
      // Backend still validates CSRF tokens and entitlement. Reject a foreign browser origin early.
      const origin = request.headers.get('Origin');
      if (origin && origin !== publicOrigin) return unavailable('origin_not_allowed', 403);
      // Only this signed provider endpoint is server-to-server; the API verifies its raw body.
      const signedWebhook = request.method === 'POST' && url.pathname === '/api/v1/billing/stripe/webhook';
      if (!SAFE_METHODS.has(request.method) && origin !== publicOrigin && !signedWebhook) return unavailable('origin_required', 403);
      // This request-only presentation hint is accepted only on the private same-origin API boundary.
      // Repeated headers are combined by Fetch into a comma-separated value and fail this exact check.
      const explicitLocale = request.headers.get('X-Justup-Locale');
      if (explicitLocale !== null && !/^(?:en|de|fr|it|es)$/.test(explicitLocale)) return response(JSON.stringify({ error: { code: 'invalid_locale', message: 'Choose a supported interface language.', requestId: crypto.randomUUID() } }), 400, { 'Content-Type': 'application/json' }, true);
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (HOP_HEADERS.includes(key.toLowerCase()) || /^(forwarded|x-forwarded-|cf-|x-real-ip|host$|x-justup-(?:ingress|client-ip)$)/i.test(key)) headers.delete(key);
      }
      headers.delete('If-None-Match');
      headers.delete('If-Modified-Since');
      headers.set('X-Forwarded-Proto', 'https');
      headers.set('X-Forwarded-Host', url.host);
      headers.set('Cache-Control', 'no-store');
      try {
        if (apiOrigin === publicOrigin) throw new Error('Invalid upstream origin');
        for (const [key, value] of trustedIngressHeaders(request, env)) headers.set(key, value);
        const target = new URL(apiOrigin);
        target.pathname = url.pathname;
        target.search = url.search;
        const upstream = await fetchUpstream(target.href, {
          method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          duplex: 'half', redirect: 'manual', signal: request.signal,
          cache: 'no-store',
        });
        const outgoing = new Headers(upstream.headers);
        for (const key of HOP_HEADERS) outgoing.delete(key);
        // Backend emits relative or public-origin redirects, including provider callbacks.
        const location = outgoing.get('Location');
        if (location) {
          const redirect = new URL(location, publicOrigin);
          if (redirect.origin === apiOrigin) return unavailable('invalid_upstream_redirect');
        }
        // Body passes through untouched: SSE is never collected or buffered here.
        return response(upstream.body, upstream.status, outgoing, true);
      } catch { return unavailable(); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' }, true);
    if (!/\.[^/]+$/.test(url.pathname) || /^\/(?:[a-z]{2}\/)?companies(?:\/|$)/.test(url.pathname)) {
      if (!renderPublicDocument) return unavailable('public_renderer_unavailable');
      try {
        const templateUrl = new URL('/index.html', publicOrigin);
        const template = await env.ASSETS.fetch(new Request(templateUrl));
        if (template.status !== 200) return unavailable('document_template_unavailable');
        const rendered = await renderPublicDocument(request, env, await template.text(), fetchUpstream);
        return response(request.method === 'HEAD' ? null : rendered.body, rendered.status, rendered.headers, true, mode === 'production' && rendered.status === 200 && !rendered.headers.has('X-Robots-Tag'), mode === 'production' && rendered.status === 200 && rendered.headers.get('X-Robots-Tag') === 'noindex, follow' ? 'noindex, follow' : null);
      } catch { return unavailable('public_document_unavailable'); }
    }
    try {
      const assetUrl = new URL(request.url);
      if (assetUrl.pathname === '/') assetUrl.pathname = '/index.html';
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      return response(asset.body, asset.status, asset.headers, asset.status < 200 || asset.status >= 300, mode === 'production' && /^\/(?:privacy|usage)(?:\.(?:de|fr|it|es))?\.html$/.test(url.pathname) && asset.status >= 200 && asset.status < 300);
    } catch { return unavailable(); }
  };
}
export default { fetch: createHandler() };
