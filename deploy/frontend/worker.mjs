// Preview edge boundary. Read when changing public routing, privacy headers or API streaming.
const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
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

function response(body, status, headers = {}, privateResponse = false) {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) result.set(key, value);
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
  return response(JSON.stringify({ error: { code, message: status === 403 ? 'Request origin is not allowed.' : 'The preview service is unavailable.', requestId: crypto.randomUUID(), retryAfter: 30 } }), status, { 'Content-Type': 'application/json', 'Retry-After': '30' }, true);
}

export function createHandler(fetchUpstream = globalThis.fetch) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    let publicOrigin;
    try { publicOrigin = httpsOrigin(env.PUBLIC_ORIGIN); } catch { return unavailable(); }
    // Do not expose the service through alternate workers.dev/version hostnames.
    if (url.origin !== publicOrigin) return unavailable('origin_not_allowed', 403);
    if (url.pathname === '/__preview/version') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' }, true);
      try {
        const release = JSON.parse(env.RELEASE_JSON);
        const keys = ['sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256'];
        const identity = Object.fromEntries(keys.map(key => {
          if (!/^[a-f0-9]{40,64}$/.test(release[key])) throw new Error('Missing identity');
          return [key, release[key]];
        }));
        if (!/^[a-f0-9]{64}$/.test(env.RUNTIME_CONFIG_SHA256)) throw new Error('Missing config identity');
        return response(request.method === 'HEAD' ? null : JSON.stringify({ ...identity, runtimeConfigSha256: env.RUNTIME_CONFIG_SHA256, apiPrefix: '/api/v1' }), 200, { 'Content-Type': 'application/json' }, true);
      } catch { return unavailable('release_identity_unavailable'); }
    }
    if (url.pathname === '/robots.txt') return response('User-agent: *\nDisallow: /\n', 200, { 'Content-Type': 'text/plain' });
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      let apiOrigin;
      try { apiOrigin = httpsOrigin(env.API_ORIGIN); } catch { return unavailable(); }
      // Backend still validates CSRF tokens and entitlement. Reject a foreign browser origin early.
      const origin = request.headers.get('Origin');
      if (origin && origin !== publicOrigin) return unavailable('origin_not_allowed', 403);
      if (!SAFE_METHODS.has(request.method) && origin !== publicOrigin) return unavailable('origin_required', 403);
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (HOP_HEADERS.includes(key.toLowerCase()) || /^(forwarded|x-forwarded-|cf-|x-real-ip|host$)/i.test(key)) headers.delete(key);
      }
      headers.delete('If-None-Match');
      headers.delete('If-Modified-Since');
      headers.set('X-Forwarded-Proto', 'https');
      headers.set('X-Forwarded-Host', url.host);
      headers.set('Cache-Control', 'no-store');
      try {
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
    if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
    try {
      const asset = await env.ASSETS.fetch(request);
      return response(asset.body, asset.status, asset.headers);
    } catch { return unavailable(); }
  };
}
export default { fetch: createHandler() };
