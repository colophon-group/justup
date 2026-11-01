import type { InterfaceLocale } from "../i18n/locales.ts";
// Public API models. Decode network data before placing it into application state.
export interface User {
  id: string;
  username: string;
}
export interface Coverage {
  state?: string;
  kind?: string;
  description?: string;
  verifiedAt?: string | null;
  stale?: boolean;
}
export interface SessionPolicies {
  reviewed: boolean;
  version: string | null;
  privacyUrl: string | null;
  usageUrl: string | null;
  locale: InterfaceLocale;
  reviewedLocale: InterfaceLocale | null;
  fallback: boolean;
}
export interface RegistrationAcceptance {
  usageVersion: string;
  locale: InterfaceLocale;
  adultAndCapable: true;
}
export interface Session {
  user: User | null;
  serverTime?: string;
  expiresAt?: string | null;
  visitor: { expiresAt: string } | null;
  csrfToken: string;
  access: {
    kind: string;
    fullAccess: boolean;
    billingEnabled: boolean;
    until?: string | null;
    description?: string;
  };
  capabilities: Record<string, boolean>;
  authentication: {
    method: string;
    loginEnabled: boolean;
    registrationEnabled: boolean;
    requiresInvitation: boolean;
    reason: string | null;
  };
  policies: SessionPolicies;
  coverage?: Coverage;
}
export type SearchScope = "account" | "visitor";
export interface SavedWorkspaceState {
  activeSearchId: string | null;
  drafts: Record<string, string>;
}
export interface WorkspaceSnapshot {
  revision: number;
  state: SavedWorkspaceState;
  viewed: { jobId: string; firstViewedAt: string }[];
  recoveredDrafts: { id: string; text: string; createdAt: string }[];
}
export interface Requirement {
  id?: string;
  text: string;
  handling: string;
  reason?: string;
}
export interface CompanyRequestPrefill {
  input: string;
  scope: string | null;
}
export interface Warning {
  code?: string;
  message: string;
  companyRequestPrefill?: CompanyRequestPrefill;
}
export interface Search {
  id: string;
  revision: number;
  query: string;
  title: string;
  status: string;
  description?: string;
  requirements: Requirement[];
  warnings: Warning[];
  draft?: { query: string; taskId: string | null; status?: string };
  proposal?: SearchProposal;
}
export interface SearchProposal {
  proposalId: string;
  searchId: string;
  expectedRevision: number;
  query: string;
  title: string;
  requirements: Requirement[];
  warnings: Warning[];
  message?: string;
}
export interface Salary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
}
export interface Company {
  id: string;
  name: string;
  logoUrl?: string | null;
  description?: string;
  industry?: string;
  coverage?: Coverage;
  websiteUrl?: string;
  domain?: string;
  evidenceUrls?: string[];
  lastSuccessfulCheckAt?: string;
  monitoringSince?: string;
  hiringHistory?: { date: string; count: number }[];
  hiringRoles?: { name: string; count?: number }[];
  reportedSalaries?: { role?: string; text: string }[];
}
// Narrow public projection of the report; unknown analytic sections stay out of hydration.
export interface CompanySourceReport {
  companyId: string;
  asOf: string;
  sourceChecks: {
    state: "available" | "partial" | "unavailable";
    items: {
      publicLink: { url: string; status: "approved"; provenance: "employer-careers" | "ats-careers" | "reviewed-redirect"; approvedAt: string } | null;
      trackedSince: string;
      lastVerifiedAt: string | null;
    }[];
  };
}
export interface CompanyCataloguePage {
  items: Company[];
  nextCursor: string | null;
  coverage?: Coverage;
}
export interface Job {
  id: string;
  title: string;
  company: Company;
  sourceUrl: string;
  firstObserved: string;
  locations: { name: string; workplace?: string }[];
  employmentTypes: string[];
  salary: Salary | null;
  viewed?: boolean;
  isNew?: boolean;
}
export type ContinuationState =
  "open" | "pending" | "paused" | "exhausted" | "failed";
export type HiddenMatches =
  | { status: "exact" | "lower_bound"; count: number }
  | { status: "pending" | "unavailable"; count: null };
export interface ResultPage {
  searchId: string;
  revision: number;
  items: Job[];
  continuation: {
    state: ContinuationState;
    cursor: string | null;
    retryAfterMs: number | null;
  };
  ai: {
    status: string;
    pending?: number;
    failed?: number;
    insufficientEvidence?: number;
  };
  hiddenMatches: HiddenMatches;
  coverage?: Coverage;
}
export interface CompanyRequest {
  id: string;
  input: string;
  status: "pending" | "candidate" | "clarification" | "unresolved" | "accepted";
  candidate: Company | null;
  previewRevision: number | null;
  clarification?: string | null;
  message?: string;
  reason?: string;
  company?: Company;
  taskId?: string | null;
}
export type TaskResult =
  | { search: Search }
  | { proposal: SearchProposal }
  | { request: CompanyRequest };
export interface Task {
  id: string;
  kind: string;
  status: "pending" | "running" | "succeeded" | "warning" | "failed";
  result: TaskResult | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
export interface SearchSubmission {
  search: Search;
  task?: Task;
}
export interface RequestSubmission {
  request: CompanyRequest;
  task?: Task;
}

export interface HiringWireItem {
  company: { id: string; name: string; url: string };
  headline: string;
  activity: {
    current: number;
    previous: number;
    change: number;
    percentageChange: number | null;
  };
  scope: "Comparable career pages";
}
export interface HiringWireEdition {
  id: string;
  title: "Hiring Wire";
  period: { start: string; end: string; previousStart: string };
  snapshotAt: string;
  publishedAt: string;
  expiresAt: string;
  methodology: string;
  items: HiringWireItem[];
}
export type HiringWire =
  | { state: "unavailable"; edition: null }
  | { state: "published"; edition: HiringWireEdition };
