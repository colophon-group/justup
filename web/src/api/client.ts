import { parseInterfaceLocale, type InterfaceLocale } from "../i18n/locales.ts";
// Same-origin transport owns credentials, timeouts and response validation, not UI state.
import {
  decodeCompany,
  decodeCompanySourceReport,
  decodeCompanyCataloguePage,
  decodeCompanyRequest,
  decodeHiringWire,
  decodeRequestList,
  decodeRequestSubmission,
  decodeResults,
  decodeSearch,
  decodeSearchList,
  decodeSearchSubmission,
  decodeSession,
  decodeTask,
  decodeWorkspace,
  record,
} from "./decode.ts";
import type { RegistrationAcceptance, SavedWorkspaceState, SearchScope, Session } from "./types.ts";
import { sessionOwner } from './sessionOwner.ts';
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function errorText(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message}${error.retryAfter ? ` Try again after ${error.retryAfter} seconds.` : ""}${error.requestId ? ` Reference: ${error.requestId}.` : ""}`;
  return error instanceof Error
    ? error.message
    : "The service is unavailable. Please try again.";
}
interface Options {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal | undefined;
  key?: string | undefined;
  keepalive?: boolean;
  expectedVisitorReclamation?: boolean;
}
interface ClientOptions {
  fetch?: typeof fetch;
  onSessionExpired?: () => void;
  onVisitorExpired?: () => void;
  timeoutMs?: number;
  onAuthenticationChanged?: () => void;
}
const ignored = (value: unknown): void => {
  if (value !== undefined) record(value, "acknowledgement");
};
const id = encodeURIComponent;
const searchPath = (scope: SearchScope) => scope === "visitor" ? "/visitor/searches" : "/searches";
export class ApiClient {
  private explicitRequestLocale: InterfaceLocale | null = null;
  private csrfToken: string | null = null;
  private sessionVersion = 0;
  private suspended = false;
  private owner: string | null = null;
  private readonly privateRequests = new Set<AbortController>();
  private readonly resumed = new Set<() => void>();
  private readonly suspending = new Set<() => void>();
  private readonly fetcher: typeof fetch;
  private readonly onSessionExpired: (() => void) | undefined;
  private readonly onVisitorExpired: (() => void) | undefined;
  private readonly timeoutMs: number;
  private readonly onAuthenticationChanged: (() => void) | undefined;
  constructor(options: ClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
    this.onVisitorExpired = options.onVisitorExpired;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.onAuthenticationChanged = options.onAuthenticationChanged;
  }
  // Request-only route presentation; never persists a preference or changes a query.
  setExplicitRequestLocale(locale: InterfaceLocale | null): void {
    if (locale !== null && parseInterfaceLocale(locale) === null) throw new TypeError('Invalid explicit interface locale.');
    this.explicitRequestLocale = locale;
  }
  setSession(session: Session | null, preserveVisitor = false): void {
    const wasSuspended = this.suspended, previousOwner = this.owner, previousCsrf = this.csrfToken;
    this.sessionVersion++;
    this.csrfToken = session?.csrfToken || null;
    this.owner = sessionOwner(session);
    this.suspended = false;
    if (!session || previousOwner !== this.owner) {
      for (const controller of this.privateRequests) controller.abort(new DOMException('Session owner changed', 'AbortError'));
      this.privateRequests.clear();
    }
    const version = this.sessionVersion;
    const owner = this.owner;
    const sameGuest = preserveVisitor && previousOwner !== null && !previousOwner.startsWith('account:') && !owner?.startsWith('account:') && previousCsrf === this.csrfToken;
    if (wasSuspended && session && (previousOwner === owner || sameGuest)) {
      queueMicrotask(() => { if (!this.suspended && this.owner === owner && this.sessionVersion === version) for (const listener of this.resumed) listener(); });
    }
  }
  suspendSession(): void {
    this.sessionVersion++;
    this.suspended = true;
    for (const controller of this.privateRequests) controller.abort(new DOMException('Session is being checked', 'AbortError'));
    this.privateRequests.clear();
    for (const listener of this.suspending) listener();
  }
  isSessionSuspended(): boolean { return this.suspended; }
  onSessionSuspended(listener: () => void): () => void {
    this.suspending.add(listener);
    return () => { this.suspending.delete(listener); };
  }
  onSessionResumed(listener: () => void): () => void {
    this.resumed.add(listener);
    return () => { this.resumed.delete(listener); };
  }
  async request<T>(
    path: string,
    decode: (value: unknown) => T,
    options: Options = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid API path.");
    const method = options.method ?? "GET",
      mutation = method !== "GET",
      sessionVersion = this.sessionVersion;
    const publicRead = !mutation && (path === '/session' || path === '/hiring-wire' || path === '/companies' || path.startsWith('/companies?') || path.startsWith('/companies/'));
    if (this.suspended && !publicRead) throw new DOMException('Session is being checked', 'AbortError');
    if (mutation && !this.csrfToken)
      throw new ApiError(
        403,
        "csrf_unavailable",
        "Please reconnect before trying again.",
      );
    const body = mutation && options.body === undefined ? {} : options.body;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.explicitRequestLocale !== null) headers["X-Justup-Locale"] = this.explicitRequestLocale;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (mutation && this.csrfToken) headers["X-CSRF-Token"] = this.csrfToken;
    if (options.key) headers["Idempotency-Key"] = options.key;
    const controller = new AbortController();
    if (!publicRead) this.privateRequests.add(controller);
    const stale = () => !publicRead && (sessionVersion !== this.sessionVersion || this.suspended);
    let cancel!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () => reject(new DOMException('Request cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "TimeoutError")),
      this.timeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await Promise.race([this.fetcher("/api/v1" + path, {
          method,
          credentials: "same-origin",
          cache: "no-store",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
        }), cancellation]);
      } catch (error) {
        if (options.signal?.aborted || stale())
          throw new DOMException("Request cancelled", "AbortError");
        throw new ApiError(
          0,
          "network_unavailable",
          controller.signal.aborted
            ? "The request timed out. Please try again."
            : "The service is unavailable. Your accepted search has been kept.",
        );
      }
      if (options.signal?.aborted || stale())
        throw new DOMException("Request cancelled", "AbortError");
      if (controller.signal.aborted)
        throw new ApiError(
          0,
          "request_timeout",
          "The request timed out. Please try again.",
        );
      let value: unknown;
      try {
        value = response.status === 204 ? undefined : await Promise.race([response.json(), cancellation]);
      } catch {
        if (options.signal?.aborted || stale())
          throw new DOMException("Request cancelled", "AbortError");
        throw new ApiError(
          response.status,
          "invalid_response",
          "The service returned an unreadable response. Please retry.",
        );
      }
      if (options.signal?.aborted || stale())
        throw new DOMException("Request cancelled", "AbortError");
      if (controller.signal.aborted)
        throw new ApiError(
          0,
          "request_timeout",
          "The request timed out. Please try again.",
        );
      if (!response.ok) {
        const envelope =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? record(value)
            : {};
        const failure =
          envelope.error !== null &&
          typeof envelope.error === "object" &&
          !Array.isArray(envelope.error)
            ? record(envelope.error)
            : {};
        const code =
          typeof failure.code === "string" ? failure.code : "unavailable";
        const message =
          typeof failure.message === "string"
            ? failure.message
            : "The service could not complete this request.";
        const retryHeader = response.headers.get("Retry-After");
        const retry =
          retryHeader && /^\d+$/.test(retryHeader)
            ? Number(retryHeader)
            : undefined;
        const error = new ApiError(
          response.status,
          code,
          message,
          typeof failure.requestId === "string" ? failure.requestId : undefined,
          retry,
        );
        if (
          response.status === 401 &&
          sessionVersion === this.sessionVersion &&
          !(options.expectedVisitorReclamation && path === "/visitor/workspace" && method === "PATCH") &&
          ["unauthenticated", "session_expired"].includes(code)
        ) {
          this.setSession(null);
          if (path.startsWith("/visitor/")) this.onVisitorExpired?.();
          else this.onSessionExpired?.();
        }
        throw error;
      }
      return decode(value);
    } finally {
      this.privateRequests.delete(controller);
      controller.signal.removeEventListener('abort', cancel);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  getSession(signal?: AbortSignal) {
    return this.request("/session", decodeSession, { signal });
  }
  getHiringWire(signal?: AbortSignal) {
    return this.request("/hiring-wire", decodeHiringWire, { signal });
  }
  getWorkspace(scope: SearchScope, signal?: AbortSignal) {
    return this.request(`${scope === "visitor" ? "/visitor" : ""}/workspace`, decodeWorkspace, { signal });
  }
  saveWorkspace(scope: SearchScope, state: SavedWorkspaceState, expectedRevision: number, signal?: AbortSignal, expectedVisitorReclamation = false) {
    return this.request(`${scope === "visitor" ? "/visitor" : ""}/workspace`, decodeWorkspace, {
      method: "PATCH", body: { expectedRevision, ...state }, signal, keepalive: true, expectedVisitorReclamation: scope === "visitor" && expectedVisitorReclamation,
    });
  }
  recoverDraft(scope: SearchScope, draftId: string, action: "use" | "discard", expectedRevision: number, signal?: AbortSignal) {
    return this.request(`${scope === "visitor" ? "/visitor" : ""}/workspace/recovered-drafts/${id(draftId)}`, decodeWorkspace, {
      method: "POST", body: { expectedRevision, action }, signal,
    });
  }
  listSearches(signal?: AbortSignal, scope: SearchScope = "account") {
    return this.request(searchPath(scope), decodeSearchList, { signal });
  }
  createSearch(
    body: { query: string; requestKey: string },
    signal?: AbortSignal,
    scope: SearchScope = "account",
  ) {
    return this.request(searchPath(scope), decodeSearchSubmission, {
      method: "POST",
      body,
      key: body.requestKey,
      signal,
    });
  }
  editSearch(
    searchId: string,
    body: { query: string; requestKey: string; expectedRevision: number },
    signal?: AbortSignal,
    scope: SearchScope = "account",
  ) {
    return this.request(`${searchPath(scope)}/${id(searchId)}`, decodeSearchSubmission, {
      method: "PATCH",
      body,
      key: body.requestKey,
      signal,
    });
  }
  confirmSearch(
    searchId: string,
    body: { proposalId: string; expectedRevision: number },
    key: string,
    signal?: AbortSignal,
    scope: SearchScope = "account",
  ) {
    return this.request(
      `${searchPath(scope)}/${id(searchId)}/confirm`,
      (value) => decodeSearch(record(value).search),
      { method: "POST", body, key, signal },
    );
  }
  deleteSearch(searchId: string, signal?: AbortSignal, scope: SearchScope = "account") {
    return this.request(`${searchPath(scope)}/${id(searchId)}`, ignored, {
      method: "DELETE",
      signal,
    });
  }
  getResults(
    searchId: string,
    revision: number,
    cursor?: string | null,
    signal?: AbortSignal,
    scope: SearchScope = "account",
  ) {
    const query = new URLSearchParams({
      revision: String(revision),
      limit: "12",
    });
    if (cursor) query.set("cursor", cursor);
    return this.request(
      `${searchPath(scope)}/${id(searchId)}/results?${query}`,
      decodeResults,
      { signal },
    );
  }
  getCompanyCataloguePage(query: string, cursor?: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ q: query, limit: '20' });
    if (cursor) params.set('cursor', cursor);
    return this.request('/companies?' + params, decodeCompanyCataloguePage, { signal });
  }
  getCompany(companyId: string, signal?: AbortSignal) {
    return this.request(
      `/companies/${id(companyId)}`,
      (value) => {
        const o = record(value);
        return decodeCompany(o.company ?? o);
      },
      { signal },
    );
  }
  getCompanySourceReport(companyId: string, signal?: AbortSignal) {
    return this.request(`/companies/${id(companyId)}/report`, value => decodeCompanySourceReport(value, companyId), { signal });
  }
  createCompanyRequest(
    body: {
      input: string;
      requestKey: string;
      domain?: string;
      careerUrl?: string;
      scope?: string;
    },
    signal?: AbortSignal,
  ) {
    return this.request("/company-requests", decodeRequestSubmission, {
      method: "POST",
      body,
      key: body.requestKey,
      signal,
    });
  }
  listCompanyRequests(signal?: AbortSignal) {
    return this.request("/company-requests", decodeRequestList, { signal });
  }
  acceptCompanyRequest(
    requestId: string,
    body: { candidateId: string; previewRevision: number },
    key: string,
    signal?: AbortSignal,
  ) {
    return this.request(
      `/company-requests/${id(requestId)}/accept`,
      (value) => decodeCompanyRequest(record(value).request),
      { method: "POST", body, key, signal },
    );
  }
  deleteCompanyRequest(requestId: string, signal?: AbortSignal) {
    return this.request(`/company-requests/${id(requestId)}`, ignored, {
      method: "DELETE",
      signal,
    });
  }
  getTask(taskId: string, signal?: AbortSignal, scope: SearchScope = "account") {
    return this.request(`${scope === "visitor" ? "/visitor" : ""}/tasks/${id(taskId)}`, decodeTask, { signal });
  }
  markViewed(jobId: string, scope: SearchScope, signal?: AbortSignal) {
    return this.request(`${scope === "visitor" ? "/visitor" : ""}/viewed`, ignored, {
      method: "POST", body: { jobId }, signal,
    });
  }
  async login(body: { username: string; password: string }, signal?: AbortSignal) {
    await this.request("/auth/login", ignored, {
      method: "POST",
      body: { username: body.username, password: body.password },
      signal,
    });
    this.onAuthenticationChanged?.();
  }
  async register(
    body: { username: string; password: string; inviteCode?: string; acceptance: RegistrationAcceptance },
    signal?: AbortSignal,
  ) {
    await this.request("/auth/register", ignored, {
      method: "POST",
      body,
      signal,
    });
    this.onAuthenticationChanged?.();
  }
  async logout(signal?: AbortSignal) {
    await this.request("/session/logout", ignored, { method: "POST", signal });
    this.onAuthenticationChanged?.();
  }
  async deleteAccount(password: string, key?: string, signal?: AbortSignal) {
    await this.request("/account", ignored, {
      method: "DELETE",
      body: { password },
      key,
      signal,
    });
    this.onAuthenticationChanged?.();
  }
}
