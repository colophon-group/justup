'use strict';
// Same-origin transport. Session credentials and user data never enter browser storage.
window.JustupApi = (() => {
  let csrfToken = null;
  class ApiError extends Error {
    constructor(status, data = {}) {
      super(typeof data.message === 'string' ? data.message : 'The service could not complete this request.');
      this.status = status;
      this.code = data.code || 'unavailable';
      this.requestId = data.requestId;
      this.retryAfter = data.retryAfter;
      this.details = data.details;
    }
  }
  async function request(path, { method = 'GET', body, signal, idempotencyKey } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    const mutation = method !== 'GET';
    if (mutation && !csrfToken) throw new ApiError(403, { code: 'csrf_unavailable', message: 'Please refresh the page before trying again.' });
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (mutation) headers['X-CSRF-Token'] = csrfToken;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await fetch('/api/v1' + path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, { code: 'network_unavailable', message: 'The service is unavailable. Your last accepted search has been kept.' });
    }
    if (response.status === 204) return {};
    let data;
    try { data = await response.json(); } catch { throw new ApiError(response.status, { code: 'invalid_response', message: 'The service returned an unreadable response. Please try again.' }); }
    if (!response.ok) {
      const error = new ApiError(response.status, { ...data.error, retryAfter: data.error?.retryAfter || response.headers.get('Retry-After') });
      if (response.status === 401 && ['session_expired', 'unauthenticated'].includes(error.code) && !path.startsWith('/auth/')) window.dispatchEvent(new Event('justup-session-expired'));
      throw error;
    }
    return data;
  }
  return { request, ApiError, setSession(session) { csrfToken = session?.csrfToken || null; }, key() { return crypto.randomUUID(); } };
})();
