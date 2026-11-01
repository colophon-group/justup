import { safePublicCompanyURL, safePublicCompanyDomain } from './publicCompanyUrls.ts';
import { parseInterfaceLocale } from "../i18n/locales.ts";
// Validate public response shapes at the network boundary; ignore unrequested private fields.
import type {
  Company,
  CompanyCataloguePage,
  CompanyRequest,
  CompanyRequestPrefill,
  Coverage,
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
    user:
      user === null
        ? null
        : {
            id: text(user.id, "account identity"),
            username: text(user.username, "username"),
          },
    csrfToken: text(o.csrfToken, "session token"),
    access: {
      kind: text(access.kind, "access kind"),
      fullAccess: flag(access.fullAccess, "access status"),
      billingEnabled: flag(access.billingEnabled, "billing status"),
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
    ...(o.hidden == null
      ? {}
      : {
          hidden: (() => {
            const h = record(o.hidden, "hidden count");
            return {
              count: count(h.count, "hidden count"),
              exact: flag(h.exact, "count precision"),
            };
          })(),
        }),
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
