import { safePublicCompanyURL, safePublicCompanyDomain } from './publicCompanyUrls.ts';
import { parseInterfaceLocale } from "../i18n/locales.ts";
// Validate public response shapes at the network boundary; ignore unrequested private fields.
import type {
  Company,
  CompanyCataloguePage,
  CompanySourceReport,
  CompanyRequest,
  CompanyRequestPrefill,
  Coverage,
  HiringWire,
  HiringWireItem,
  Job,
  RequestSubmission,
  Requirement,
  ResultPage,
  Salary,
  Search,
  SearchProposal,
  SearchSubmission,
  Session,
  SessionPolicies,
  Task,
  TaskResult,
  Warning,
  WorkspaceSnapshot,
} from "./types.ts";
export class ContractError extends Error {
  constructor(detail: string) {
    super(
      `The service returned an invalid ${detail}. Please retry or reconnect.`,
    );
    this.name = "ContractError";
  }
}
const fail = (label: string): never => {
  throw new ContractError(label);
};
export function record(
  value: unknown,
  label = "response",
): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(label);
}
const text = (value: unknown, label: string): string =>
  typeof value === "string" ? value : fail(label);
const flag = (value: unknown, label: string): boolean =>
  typeof value === "boolean" ? value : fail(label);
const count = (value: unknown, label: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(label);
const amount = (value: unknown): number | null =>
  value === null || value === undefined
    ? null
    : typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : fail("salary");
const nullableText = (value: unknown, label: string): string | null =>
  value == null ? null : text(value, label);
function list<T>(
  value: unknown,
  decode: (entry: unknown) => T,
  label: string,
): T[] {
  return Array.isArray(value) ? value.map(decode) : fail(label);
}
function optionalText(
  object: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return object[key] == null ? {} : { [key]: text(object[key], key) };
}
export function safeSourceURL(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function date(value: unknown): string {
  const result = text(value, "timestamp");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(
    result,
  ) &&
    Number.isFinite(Date.parse(result)) &&
    new Date(result).toISOString().slice(0, 19) === result.slice(0, 19)
    ? result
    : fail("timestamp");
}

// A public edition carries comparable weekly facts, never inferred history or free-form links.
export function decodeHiringWire(value: unknown): HiringWire {
  const envelope = record(value, "company news");
  if (envelope.state === "unavailable" && envelope.edition === null)
    return { state: "unavailable", edition: null };
  if (envelope.state !== "published") fail("company news state");
  const edition = record(envelope.edition, "company news edition");
  try {
    if (new TextEncoder().encode(JSON.stringify(edition)).byteLength > 16_384) fail("company news edition size");
  } catch { return fail("company news edition size"); }
  const bounded = (value: unknown, label: string, maximum: number) => {
    const result = text(value, label);
    return result.trim() && result.length <= maximum && !/[\u0000-\u001f\u007f<>]/u.test(result)
      ? result : fail(label);
  };
  const identifier = (value: unknown) => {
    const result = text(value, "news company identity");
    return /^[A-Za-z0-9_.:-]{1,128}$/u.test(result) ? result : fail("news company identity");
  };
  const homepage = (value: unknown) => {
    const result = bounded(value, "news company URL", 2048);
    if (/[\u0000-\u0020\u007f\\?#]/u.test(result) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(result)
      || /^https:\/\/[^/]*@/iu.test(result)) fail("news company URL");
    let url: URL;
    try { url = new URL(result); } catch { return fail("news company URL"); }
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && !url.search && !url.hash && url.href === result && url.hostname.length <= 253
      && /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|localdomain|internal|invalid|test|home|lan|private|corp|intranet|arpa|onion)$/u.test(url.hostname)
      && url.hostname.split(".").every(part => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part))
      ? result : fail("news company URL");
  };
  const period = record(edition.period, "news comparison period");
  const start = date(period.start), end = date(period.end), previousStart = date(period.previousStart);
  const snapshotAt = date(edition.snapshotAt), publishedAt = date(edition.publishedAt), expiresAt = date(edition.expiresAt);
  const week = 7 * 86_400_000;
  if (Date.parse(end) - Date.parse(start) !== week || Date.parse(start) - Date.parse(previousStart) !== week
    || new Date(end).getUTCDay() !== 1 || Date.parse(end) % 86_400_000 !== 0
    || snapshotAt !== end || Date.parse(publishedAt) < Date.parse(end)
    || Date.parse(expiresAt) - Date.parse(end) !== week || Date.parse(publishedAt) >= Date.parse(expiresAt)
    || edition.id !== end.slice(0, 10) || edition.title !== "Hiring Wire") fail("news comparison period");
  if (!Array.isArray(edition.items) || edition.items.length < 1 || edition.items.length > 6) fail("company news items");
  const seen = new Set<string>();
  const items = list(edition.items, value => {
    const item = record(value, "company news item"), company = record(item.company, "news company");
    const id = identifier(company.id);
    if (seen.has(id)) fail("duplicate news company");
    seen.add(id);
    const activity = record(item.activity, "listing activity");
    const current = count(activity.current, "listing activity"), previous = count(activity.previous, "listing activity");
    const change = current - previous;
    const percentageChange = previous === 0 ? null : Math.round(change / previous * 1000) / 10;
    if (current + previous === 0 || activity.change !== change || activity.percentageChange !== percentageChange
      || item.scope !== "Comparable career pages") fail("listing comparison");
    return {
      company: { id, name: bounded(company.name, "news company name", 200), url: homepage(company.url) },
      headline: bounded(item.headline, "news headline", 320),
      activity: { current, previous, change, percentageChange },
      scope: "Comparable career pages",
    } satisfies HiringWireItem;
  }, "company news items");
  return { state: "published", edition: {
    id: text(edition.id, "news edition identity"), title: "Hiring Wire", period: { start, end, previousStart },
    snapshotAt, publishedAt, expiresAt, methodology: bounded(edition.methodology, "news methodology", 1000), items,
  } };
}
export function decodeCoverage(value: unknown): Coverage {
  const o = record(value, "coverage");
  return {
    ...optionalText(o, "state"),
    ...optionalText(o, "kind"),
    ...optionalText(o, "description"),
    ...(o.verifiedAt === undefined
      ? {}
      : { verifiedAt: o.verifiedAt === null ? null : date(o.verifiedAt) }),
    ...(o.stale == null ? {} : { stale: flag(o.stale, "coverage status") }),
  };
}
// Career links need explicit report approval; syntactically safe legacy URLs are insufficient.
export function decodeCompanySourceReport(value: unknown, expectedCompanyId: string): CompanySourceReport {
  const o = record(value, "company report");
  const companyId = text(o.companyId, "company report identity");
  if (companyId !== expectedCompanyId) fail("company report identity");
  const asOf = date(o.asOf), checks = record(o.sourceChecks, "source checks");
  if (!["available", "partial", "unavailable"].includes(String(checks.state))) fail("source check state");
  const entries: unknown[] = Array.isArray(checks.items) && checks.items.length <= 2000 ? checks.items : fail("source checks");
  const items: CompanySourceReport["sourceChecks"]["items"] = entries.map(value => {
    const item = record(value, "source check");
    const trackedSince = date(item.trackedSince);
    const lastVerifiedAt = item.lastVerifiedAt === null ? null : date(item.lastVerifiedAt);
    if (Date.parse(trackedSince) > Date.parse(asOf) || (lastVerifiedAt && Date.parse(lastVerifiedAt) > Date.parse(asOf))) fail("source check timestamp");
    if (item.publicLink === null) return { publicLink: null, trackedSince, lastVerifiedAt };
    const link = record(item.publicLink, "approved career link");
    const url = safePublicCompanyURL(link.url), approvedAt = date(link.approvedAt);
    if (!url || url !== link.url || url.length > 2048 || /[^\u0021-\u007e]|%/u.test(url) || new URL(url).search || new URL(url).hash
      || link.status !== "approved" || !["employer-careers", "ats-careers", "reviewed-redirect"].includes(String(link.provenance))
      || Date.parse(approvedAt) > Date.parse(asOf)) return fail("approved career link");
    return { publicLink: { url, status: "approved", provenance: link.provenance as NonNullable<CompanySourceReport["sourceChecks"]["items"][number]["publicLink"]>["provenance"], approvedAt }, trackedSince, lastVerifiedAt };
  });
  const linked = items.filter(item => item.publicLink !== null).length;
  const state = linked === 0 ? "unavailable" : linked === items.length ? "available" : "partial";
  if (checks.state !== state) fail("source check state");
  return { companyId, asOf, sourceChecks: { state, items } };
}
export function decodeCompany(value: unknown): Company {
  const o = record(value, "company");
  const domain = safePublicCompanyDomain(o.domain), websiteUrl = safePublicCompanyURL(o.websiteUrl);
  return {
    id: text(o.id, "company identity"),
    name: text(o.name, "company name"),
    ...optionalText(o, "description"),
    ...optionalText(o, "industry"),
    ...(domain ? { domain } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(o.logoUrl == null ? {} : { logoUrl: safePublicCompanyURL(o.logoUrl) }),
    ...(o.coverage == null ? {} : { coverage: decodeCoverage(o.coverage) }),
    // Raw legacy sources never establish approved career-page links. Only the later
    // report sourceChecks contract may supply those; do not retain them in hydration data.
    ...(Array.isArray(o.evidenceUrls) ? { evidenceUrls: o.evidenceUrls.map(safePublicCompanyURL).filter((url): url is string => url !== null) } : {}),
    ...optionalText(o, "lastSuccessfulCheckAt"),
    ...optionalText(o, "monitoringSince"),
    ...(o.hiringHistory == null
      ? {}
      : {
          hiringHistory: list(
            o.hiringHistory,
            (v) => {
              const point = record(v, "historical observation");
              return {
                date: date(point.date),
                count: count(point.count, "historical count"),
              };
            },
            "hiring history",
          ),
        }),
    ...(o.hiringRoles == null
      ? {}
      : {
          hiringRoles: list(
            o.hiringRoles,
            (v) => {
              const role = record(v, "hiring role");
              return {
                name: text(role.name, "role name"),
                ...(role.count == null
                  ? {}
                  : { count: count(role.count, "role count") }),
              };
            },
            "hiring roles",
          ),
        }),
    ...(o.reportedSalaries == null
      ? {}
      : {
          reportedSalaries: list(
            o.reportedSalaries,
            (v) => {
              const salary = record(v, "salary report");
              return {
                text: text(salary.text, "salary report"),
                ...optionalText(salary, "role"),
              };
            },
            "salary reports",
          ),
        }),
  };
}
// Optional compiler hints cannot invalidate an otherwise usable warning.
function decodePrefill(value: unknown): CompanyRequestPrefill | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const o = value as Record<string, unknown>;
  const valid = (v: unknown): v is string =>
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  if (!valid(o.input) || (o.scope !== null && !valid(o.scope))) return;
  return {
    input: o.input.trim(),
    scope: o.scope === null ? null : o.scope.trim(),
  };
}
const decodeWarning = (value: unknown): Warning => {
  if (typeof value === "string") return { message: value };
  const o = record(value, "warning");
  const prefill =
    o.code === "company_not_found"
      ? decodePrefill(o.companyRequestPrefill)
      : undefined;
  return {
    message: text(o.message, "warning"),
    ...optionalText(o, "code"),
    ...(prefill ? { companyRequestPrefill: prefill } : {}),
  };
};
const decodeRequirement = (value: unknown): Requirement => {
  const o = record(value, "requirement");
  return {
    text: text(o.text, "requirement text"),
    handling: text(o.handling, "requirement handling"),
    ...optionalText(o, "id"),
    ...optionalText(o, "reason"),
  };
};
export function decodeSearch(value: unknown): Search {
  const o = record(value, "search");
  return {
    id: text(o.id, "search identity"),
    revision: count(o.revision, "search revision"),
    query: text(o.query, "search text"),
    title: text(o.title, "search title"),
    status: text(o.status, "search status"),
    ...optionalText(o, "description"),
    requirements: list(o.requirements ?? [], decodeRequirement, "requirements"),
    warnings: list(o.warnings ?? [], decodeWarning, "warnings"),
    ...(o.draft == null ? {} : { draft: (() => {
      const draft = record(o.draft, "pending search text");
      return { query: text(draft.query, "pending search text"), taskId: nullableText(draft.taskId, "pending task"), ...optionalText(draft, "status") };
    })() }),
    ...(o.proposal == null ? {} : { proposal: decodeProposal(o.proposal) }),
  };
}
export function decodeWorkspace(value: unknown): WorkspaceSnapshot {
  const o = record(value, "saved workspace"), state = record(o.state, "workspace state");
  const bounded = (value: unknown, label: string, maximum: number) => {
    const result = text(value, label);
    return result.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result) ? result : fail(label);
  };
  const drafts = Object.entries(record(state.drafts, "workspace drafts"));
  if (drafts.length > 100 || new TextEncoder().encode(JSON.stringify(state)).length > 60_000) fail("workspace drafts");
  const recovered = list(o.recoveredDrafts, value => {
    const item = record(value, "saved draft");
    return { id: bounded(item.id, "saved draft identity", 128), text: bounded(item.text, "saved draft text", 4000), createdAt: date(item.createdAt) };
  }, "saved drafts");
  if (recovered.length > 100 || new Set(recovered.map(draft => draft.id)).size !== recovered.length) fail("saved drafts");
  const viewed = list(o.viewed, value => {
    const item = record(value, "viewed position");
    return { jobId: bounded(item.jobId, "viewed position identity", 128), firstViewedAt: date(item.firstViewedAt) };
  }, "viewed positions");
  if (viewed.length > 1000) fail("viewed positions");
  return {
    revision: count(o.revision, "workspace revision"),
    state: {
      activeSearchId: state.activeSearchId === null ? null : bounded(state.activeSearchId, "active search", 128),
      drafts: Object.fromEntries(drafts.map(([id, value]) => {
        if (!id || id.length > 128 || ["__proto__", "constructor", "prototype"].includes(id)) fail("draft identity");
        return [id, bounded(value, "draft text", 4000)];
      })),
    },
    viewed,
    recoveredDrafts: recovered,
  };
}
function decodeProposal(value: unknown): SearchProposal {
  const o = record(value, "search proposal");
  return {
    proposalId: text(o.proposalId, "proposal identity"),
    searchId: text(o.searchId, "proposal search"),
    expectedRevision: count(o.expectedRevision, "proposal revision"),
    query: text(o.query, "proposed text"),
    title: text(o.title, "proposed title"),
    requirements: list(o.requirements ?? [], decodeRequirement, "requirements"),
    warnings: list(o.warnings ?? [], decodeWarning, "warnings"),
    ...optionalText(o, "message"),
  };
}
export function decodePolicies(value: unknown): SessionPolicies {
  const data = record(value, 'policies');
  const reviewed = flag(data.reviewed, 'policy review');
  const locale = parseInterfaceLocale(data.locale);
  const reviewedLocale = data.reviewedLocale == null ? null : parseInterfaceLocale(data.reviewedLocale);
  const fallback = flag(data.fallback, 'policy fallback');
  if ((locale === null) || (data.reviewedLocale != null && reviewedLocale === null)
    || (reviewed && (!locale || !reviewedLocale || fallback !== (locale !== reviewedLocale)))
    || (!reviewed && (reviewedLocale !== null || fallback))) fail('policy locale approval');
  const version = nullableText(data.version, 'policy version');
  const privacyUrl = nullableText(data.privacyUrl, 'privacy URL');
  const usageUrl = nullableText(data.usageUrl, 'usage URL');
  if (reviewed && (!version || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(version) || !privacyUrl || !usageUrl)) fail('policy approval');
  return {reviewed, version, privacyUrl, usageUrl, locale: locale!, reviewedLocale, fallback};
}
export function decodeSession(value: unknown): Session {
  const o = record(value, "session"),
    access = record(o.access, "access"),
    auth = record(o.authentication, "authentication"),
    policies = record(o.policies, "policies"),
    capabilities = record(o.capabilities, "capabilities");
  const user = o.user === null ? null : record(o.user, "account");
  return {
    ...(o.serverTime === undefined ? {} : { serverTime: date(o.serverTime) }),
    ...(o.expiresAt === undefined ? {} : { expiresAt: o.expiresAt === null ? null : date(o.expiresAt) }),
    user:
      user === null
        ? null
        : {
            id: text(user.id, "account identity"),
            username: text(user.username, "username"),
          },
    visitor: o.visitor == null ? null : {
      expiresAt: date(record(o.visitor, "visitor session").expiresAt),
    },
    csrfToken: text(o.csrfToken, "session token"),
    access: {
      kind: text(access.kind, "access kind"),
      fullAccess: flag(access.fullAccess, "access status"),
      billingEnabled: flag(access.billingEnabled, "billing status"),
      ...(access.until === undefined ? {} : { until: access.until === null ? null : date(access.until) }),
      ...optionalText(access, "description"),
    },
    capabilities: Object.fromEntries(
      Object.entries(capabilities).map(([key, value]) => [
        key,
        flag(value, "capability"),
      ]),
    ),
    authentication: {
      method: text(auth.method, "authentication method"),
      loginEnabled: flag(auth.loginEnabled, "login availability"),
      registrationEnabled: flag(
        auth.registrationEnabled,
        "registration availability",
      ),
      requiresInvitation: auth.requiresInvitation === undefined
        ? true
        : flag(auth.requiresInvitation, "invitation requirement"),
      reason: nullableText(auth.reason, "authentication reason"),
    },
    policies: decodePolicies(policies),
    ...(o.coverage == null ? {} : { coverage: decodeCoverage(o.coverage) }),
  };
}
export function decodeSalary(value: unknown): Salary | null {
  if (value == null) return null;
  const o = record(value, "salary");
  const min = amount(o.min),
    max = amount(o.max);
  if (min !== null && max !== null && min > max) fail("salary bounds");
  return {
    min,
    max,
    currency: nullableText(o.currency, "currency"),
    period: nullableText(o.period, "pay period"),
  };
}
export function decodeJob(value: unknown): Job {
  const o = record(value, "position");
  return {
    id: text(o.id, "position identity"),
    title: text(o.title, "position title"),
    company: decodeCompany(o.company),
    sourceUrl: safeSourceURL(o.sourceUrl) ?? fail("position source URL"),
    firstObserved: date(o.firstObserved),
    locations: list(
      o.locations ?? [],
      (v) => {
        const l = record(v, "location");
        return {
          name: text(l.name, "location name"),
          ...optionalText(l, "workplace"),
        };
      },
      "locations",
    ),
    employmentTypes: list(
      o.employmentTypes ?? [],
      (v) => text(v, "employment type"),
      "employment types",
    ),
    salary: decodeSalary(o.salary),
    ...(o.viewed == null ? {} : { viewed: flag(o.viewed, "viewed state") }),
    ...(o.isNew == null ? {} : { isNew: flag(o.isNew, "arrival state") }),
  };
}
export function decodeResults(value: unknown): ResultPage {
  const o = record(value, "results"),
    c = record(o.continuation, "continuation"),
    state = text(c.state, "continuation state");
  if (!["open", "pending", "paused", "exhausted", "failed"].includes(state))
    fail("continuation state");
  const ai = record(o.ai ?? { status: "unavailable" }, "matching state");
  return {
    ...(o.coverage == null ? {} : { coverage: decodeCoverage(o.coverage) }),
    searchId: text(o.searchId, "result search"),
    revision: count(o.revision, "result revision"),
    items: list(o.items, decodeJob, "position list"),
    continuation: {
      state: state as ResultPage["continuation"]["state"],
      cursor: nullableText(c.cursor, "result cursor"),
      retryAfterMs:
        c.retryAfterMs == null ? null : count(c.retryAfterMs, "retry interval"),
    },
    ai: {
      status: text(ai.status, "matching status"),
      ...(ai.pending == null
        ? {}
        : { pending: count(ai.pending, "pending count") }),
      ...(ai.failed == null
        ? {}
        : { failed: count(ai.failed, "failed count") }),
      ...(ai.insufficientEvidence == null
        ? {}
        : {
            insufficientEvidence: count(
              ai.insufficientEvidence,
              "insufficient-evidence count",
            ),
          }),
    },
    hiddenMatches: (() => {
      if (o.hiddenMatches === undefined)
        return { status: "unavailable", count: null } as const;
      const h = record(o.hiddenMatches, "hidden matches");
      if (h.status === "exact" || h.status === "lower_bound")
        return { status: h.status, count: count(h.count, "hidden count") };
      if ((h.status === "pending" || h.status === "unavailable") && h.count === null)
        return { status: h.status, count: null };
      return fail("hidden matches");
    })(),
  };
}
export function decodeCompanyRequest(value: unknown): CompanyRequest {
  const o = record(value, "company request"),
    status = text(o.status, "request status");
  if (
    ![
      "pending",
      "candidate",
      "clarification",
      "unresolved",
      "accepted",
    ].includes(status)
  )
    fail("request status");
  return {
    id: text(o.id, "request identity"),
    input: text(o.input, "request input"),
    status: status as CompanyRequest["status"],
    candidate: o.candidate == null ? null : decodeCompany(o.candidate),
    previewRevision:
      o.previewRevision == null
        ? null
        : count(o.previewRevision, "preview revision"),
    ...optionalText(o, "clarification"),
    ...optionalText(o, "reason"),
    ...optionalText(o, "message"),
    ...(o.taskId == null ? {} : { taskId: text(o.taskId, "request task") }),
    ...(o.company == null ? {} : { company: decodeCompany(o.company) }),
  };
}
export function decodeTask(value: unknown): Task {
  const o = record(value, "task"),
    status = text(o.status, "task status");
  if (
    !["pending", "running", "succeeded", "warning", "failed"].includes(status)
  )
    fail("task status");
  let result: TaskResult | null = null;
  if (o.result != null) {
    const r = record(o.result, "task result");
    const tags = ["search", "proposal", "request"].filter((key) => key in r);
    if (tags.length !== 1) fail("task result tag");
    result =
      "search" in r
        ? { search: decodeSearch(r.search) }
        : "proposal" in r
          ? { proposal: decodeProposal(r.proposal) }
          : { request: decodeCompanyRequest(r.request) };
  }
  const error = o.error == null ? null : record(o.error, "task failure");
  if (
    (status === "succeeded" || status === "warning") &&
    (result === null || error !== null)
  )
    fail("task completion");
  if (status === "failed" && (result !== null || error === null))
    fail("task failure");
  if (
    (status === "pending" || status === "running") &&
    (result !== null || error !== null)
  )
    fail("pending task");
  return {
    id: text(o.id, "task identity"),
    kind: text(o.kind, "task kind"),
    status: status as Task["status"],
    result,
    error:
      error === null
        ? null
        : {
            code: text(error.code, "task error code"),
            message: text(error.message, "task error"),
            retryable: flag(error.retryable, "task retry state"),
          },
  };
}
export function decodeSearchSubmission(value: unknown): SearchSubmission {
  const o = record(value, "search submission");
  return {
    search: decodeSearch(o.search),
    ...(o.task == null ? {} : { task: decodeTask(o.task) }),
  };
}
export function decodeRequestSubmission(value: unknown): RequestSubmission {
  const o = record(value, "request submission");
  return {
    request: decodeCompanyRequest(o.request),
    ...(o.task == null ? {} : { task: decodeTask(o.task) }),
  };
}
export const decodeSearchList = (value: unknown): Search[] =>
  list(record(value).items, decodeSearch, "search list");
export const decodeCompanyList = (value: unknown): Company[] =>
  list(record(value).items, decodeCompany, "company list");
export const decodeRequestList = (value: unknown): CompanyRequest[] =>
  list(record(value).items, decodeCompanyRequest, "request list");

// Public catalogue pages have bounded source-owned continuation, never a position total.
export function decodeCompanyCataloguePage(value: unknown): CompanyCataloguePage {
  const o = record(value, 'company catalogue');
  if (!Array.isArray(o.items) || o.items.length > 50) return fail('bounded company catalogue');
  const items = list(o.items, decodeCompany, 'company catalogue');
  if (new Set(items.map(item => item.id)).size !== items.length) return fail('unique company catalogue');
  const nextCursor = o.nextCursor === null ? null : text(o.nextCursor, 'company catalogue continuation');
  if (nextCursor && (nextCursor.length > 4096 || !items.length)) return fail('bounded company catalogue continuation');
  return { items, nextCursor, ...(o.coverage == null ? {} : { coverage: decodeCoverage(o.coverage) }) };
}
