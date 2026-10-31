// Same-origin transport owns credentials, timeouts and response validation, not UI state.
import {
  decodeCompany,
  decodeCompanyList,
  decodeCompanyRequest,
  decodeRequestList,
  decodeRequestSubmission,
  decodeResults,
  decodeSearch,
  decodeSearchList,
  decodeSearchSubmission,
  decodeSession,
  decodeTask,
  record,
} from "./decode.ts";
import type { Session } from "./types.ts";
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
}
interface ClientOptions {
  fetch?: typeof fetch;
  onSessionExpired?: () => void;
  timeoutMs?: number;
}
const ignored = (value: unknown): void => {
  if (value !== undefined) record(value, "acknowledgement");
};
const id = encodeURIComponent;
export class ApiClient {
  private csrfToken: string | null = null;
  private sessionVersion = 0;
  private readonly fetcher: typeof fetch;
  private readonly onSessionExpired: (() => void) | undefined;
  private readonly timeoutMs: number;
  constructor(options: ClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }
  setSession(session: Session | null): void {
    this.sessionVersion++;
    this.csrfToken = session?.csrfToken || null;
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
    if (mutation && !this.csrfToken)
      throw new ApiError(
        403,
        "csrf_unavailable",
        "Please reconnect before trying again.",
      );
    const body = mutation && options.body === undefined ? {} : options.body;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (mutation && this.csrfToken) headers["X-CSRF-Token"] = this.csrfToken;
    if (options.key) headers["Idempotency-Key"] = options.key;
    const controller = new AbortController();
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
        response = await this.fetcher("/api/v1" + path, {
          method,
          credentials: "same-origin",
          cache: "no-store",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (options.signal?.aborted)
          throw new DOMException("Request cancelled", "AbortError");
        throw new ApiError(
          0,
          "network_unavailable",
          controller.signal.aborted
            ? "The request timed out. Please try again."
            : "The service is unavailable. Your accepted search has been kept.",
        );
      }
      if (options.signal?.aborted)
        throw new DOMException("Request cancelled", "AbortError");
      if (controller.signal.aborted)
        throw new ApiError(
          0,
          "request_timeout",
          "The request timed out. Please try again.",
        );
      let value: unknown;
      try {
        value = response.status === 204 ? undefined : await response.json();
      } catch {
        if (options.signal?.aborted)
          throw new DOMException("Request cancelled", "AbortError");
        throw new ApiError(
          response.status,
          "invalid_response",
          "The service returned an unreadable response. Please retry.",
        );
      }
      if (options.signal?.aborted)
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
          ["unauthenticated", "session_expired"].includes(code)
        ) {
          this.setSession(null);
          this.onSessionExpired?.();
        }
        throw error;
      }
      return decode(value);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  getSession(signal?: AbortSignal) {
    return this.request("/session", decodeSession, { signal });
  }
  listSearches(signal?: AbortSignal) {
    return this.request("/searches", decodeSearchList, { signal });
  }
  createSearch(
    body: { query: string; requestKey: string },
    signal?: AbortSignal,
  ) {
    return this.request("/searches", decodeSearchSubmission, {
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
  ) {
    return this.request(`/searches/${id(searchId)}`, decodeSearchSubmission, {
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
  ) {
    return this.request(
      `/searches/${id(searchId)}/confirm`,
      (value) => decodeSearch(record(value).search),
      { method: "POST", body, key, signal },
    );
  }
  deleteSearch(searchId: string, signal?: AbortSignal) {
    return this.request(`/searches/${id(searchId)}`, ignored, {
      method: "DELETE",
      signal,
    });
  }
  getResults(
    searchId: string,
    revision: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      revision: String(revision),
      limit: "12",
    });
    if (cursor) query.set("cursor", cursor);
    return this.request(
      `/searches/${id(searchId)}/results?${query}`,
      decodeResults,
      { signal },
    );
  }
  getCompanies(query: string, signal?: AbortSignal) {
    return this.request(
      "/companies?" + new URLSearchParams({ q: query }),
      decodeCompanyList,
      { signal },
    );
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
  getTask(taskId: string, signal?: AbortSignal) {
    return this.request(`/tasks/${id(taskId)}`, decodeTask, { signal });
  }
  login(body: { username: string; password: string }, signal?: AbortSignal) {
    return this.request("/auth/login", ignored, {
      method: "POST",
      body,
      signal,
    });
  }
  register(
    body: { username: string; password: string; inviteCode: string },
    signal?: AbortSignal,
  ) {
    return this.request("/auth/register", ignored, {
      method: "POST",
      body,
      signal,
    });
  }
  logout(signal?: AbortSignal) {
    return this.request("/session/logout", ignored, { method: "POST", signal });
  }
  deleteAccount(password: string, key?: string, signal?: AbortSignal) {
    return this.request("/account", ignored, {
      method: "DELETE",
      body: { password },
      key,
      signal,
    });
  }
}
