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
export interface Session {
  user: User | null;
  csrfToken: string;
  access: {
    kind: string;
    fullAccess: boolean;
    billingEnabled: boolean;
    description?: string;
  };
  capabilities: Record<string, boolean>;
  authentication: {
    method: string;
    loginEnabled: boolean;
    registrationEnabled: boolean;
    reason: string | null;
  };
  policies: {
    reviewed: boolean;
    version: string | null;
    privacyUrl: string | null;
    usageUrl: string | null;
  };
  coverage?: Coverage;
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
  sources?: { url: string; label?: string; lastSuccessfulCheckAt?: string }[];
  lastSuccessfulCheckAt?: string;
  monitoringSince?: string;
  hiringHistory?: { date: string; count: number }[];
  hiringRoles?: { name: string; count?: number }[];
  reportedSalaries?: { role?: string; text: string }[];
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
  hidden?: { count: number; exact: boolean };
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
