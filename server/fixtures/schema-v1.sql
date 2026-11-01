-- Frozen epoch-1 schema from 346f4f85ba7bb2aee59b75883c5b0e0c956ee1e3.
-- Synthetic migration inputs only; product initialization lives in its owning modules.
PRAGMA foreign_keys=ON;
CREATE TABLE access_billing_events (
      event_hash TEXT PRIMARY KEY,
      canonical_hash TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      subscription_hash TEXT NOT NULL,
      applied_version INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE access_free_periods (
      account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('standard','legacy')),
      started_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK(ends_at > started_at)
    ) STRICT;
CREATE TABLE access_identities (
      account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
      subject_hash TEXT NOT NULL UNIQUE,
      legacy_hash TEXT UNIQUE,
      verified_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE access_subscriptions (
      subscription_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL CHECK(state_version > 0),
      status TEXT NOT NULL CHECK(status IN ('unknown','active','cancelled','past_due','ended')),
      plan TEXT CHECK(plan IN ('weekly','monthly')),
      paid_through_at INTEGER,
      reconcile_pending INTEGER NOT NULL CHECK(reconcile_pending IN (0,1))
    ) STRICT;
CREATE TABLE auth_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL
    , account_expires_at INTEGER CHECK(account_expires_at IS NULL OR account_expires_at > created_at)) STRICT;
CREATE TABLE auth_sessions (
      token_hash BLOB PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
CREATE TABLE demo_company_evidence (
    request_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,preview_revision INTEGER NOT NULL,provenance_json TEXT NOT NULL
  ) STRICT;
CREATE TABLE demo_company_request_keys (
    owner_id TEXT NOT NULL, request_key TEXT NOT NULL, input_json TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY(owner_id,request_key)
  ) STRICT;
CREATE TABLE demo_company_request_tasks (
    owner_id TEXT NOT NULL,request_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_id,task_id)
  ) STRICT;
CREATE TABLE demo_company_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, input_text TEXT NOT NULL, domain TEXT, career_url TEXT, scope TEXT,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','candidate','clarification','unresolved','accepted')),
    candidate_json TEXT, preview_revision INTEGER NOT NULL, clarification TEXT, task_id TEXT, created_at INTEGER NOT NULL,
    accept_key TEXT, UNIQUE(owner_id,fingerprint)
  ) STRICT;
CREATE TABLE demo_imports (
      generation TEXT PRIMARY KEY, snapshot_at INTEGER NOT NULL, verified_at INTEGER NOT NULL,
      selection_json TEXT NOT NULL, imported_count INTEGER NOT NULL, unknown_count INTEGER NOT NULL
    ) STRICT;
CREATE TABLE demo_jev_reservations (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, window_start INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_nano INTEGER NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_jev_usage (
    scope TEXT NOT NULL, scope_key TEXT NOT NULL, window_start INTEGER NOT NULL,
    calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cost_nano INTEGER NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope,scope_key,window_start)) STRICT;
CREATE TABLE demo_jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0,1)), reserved INTEGER NOT NULL CHECK (reserved IN (0,1)),
      verified_at INTEGER NOT NULL, closed_observed_at INTEGER, evidence_hash TEXT,
      data_json TEXT NOT NULL, body_text TEXT
    ) STRICT;
CREATE TABLE demo_match_cache (
    cache_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, condition_hash TEXT NOT NULL,
    evidence_hash TEXT NOT NULL, classifier TEXT NOT NULL, decision TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_match_cache_links (
    owner_id TEXT NOT NULL, search_id TEXT NOT NULL,
    cache_key TEXT NOT NULL REFERENCES demo_match_cache(cache_key) ON DELETE CASCADE,
    PRIMARY KEY(owner_id,search_id,cache_key)) STRICT;
CREATE TABLE demo_match_cursors (
    token_hash TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES demo_match_scans(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_match_jobs (
    scan_id TEXT NOT NULL REFERENCES demo_match_scans(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, job_id TEXT NOT NULL, evidence_hash TEXT NOT NULL, cache_key TEXT NOT NULL,
    decision TEXT CHECK(decision IN ('accepted','rejected','insufficient_evidence') OR decision IS NULL),
    PRIMARY KEY(scan_id,position), UNIQUE(scan_id,job_id)) STRICT;
CREATE TABLE demo_match_scans (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, search_id TEXT NOT NULL, revision INTEGER NOT NULL,
    config_hash TEXT NOT NULL, condition_hash TEXT NOT NULL, condition TEXT NOT NULL, classifier TEXT NOT NULL,
    generation TEXT NOT NULL, access_hash TEXT NOT NULL, state TEXT NOT NULL, pause_code TEXT,
    retry_at INTEGER, task_id TEXT, round INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cohort TEXT NOT NULL DEFAULT 'visible', membership_hash TEXT NOT NULL DEFAULT '',
    UNIQUE(owner_id,search_id,revision,config_hash,classifier,generation,access_hash)) STRICT;
CREATE TABLE demo_search_cursors(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT,access_hash TEXT NOT NULL,position INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_search_delegate_cursors(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT,access_hash TEXT NOT NULL,delegate_cursor TEXT,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_search_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,search_id TEXT NOT NULL,expected_revision INTEGER NOT NULL,task_id TEXT NOT NULL,proposal_json TEXT NOT NULL) STRICT;
CREATE TABLE demo_search_submissions(owner_id TEXT NOT NULL,request_key TEXT NOT NULL,search_id TEXT NOT NULL,input_hash TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_key)) STRICT;
CREATE TABLE demo_searches(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,accepted_json TEXT,draft_json TEXT,task_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE demo_tasks (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL,
    payload_json TEXT NOT NULL, output_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','warning','failed','cancelled')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, worker_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, UNIQUE(owner_id,kind,request_key)
  ) STRICT;
CREATE TABLE hiring_wire_cleanup_halt (
    id INTEGER PRIMARY KEY CHECK(id=1),task_id TEXT NOT NULL,created_at INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason='cleanup_unproven')
  ) STRICT;
CREATE TABLE hiring_wire_editions (
    period_id TEXT PRIMARY KEY, period_end TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','published')),
    created_at INTEGER NOT NULL, published_at INTEGER, snapshot_json TEXT, snapshot_sha256 TEXT, facts_json TEXT,
    prior_json TEXT, selection_json TEXT, execution_json TEXT, workspace_json TEXT, public_json TEXT, publication_outcome TEXT NOT NULL
  ) STRICT;
CREATE TABLE hiring_wire_executions (
    id TEXT PRIMARY KEY,period_id TEXT NOT NULL,task_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN ('running','published','failed')),error_code TEXT
  ) STRICT;
CREATE TABLE hiring_wire_tool_versions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,revision TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,script_json TEXT NOT NULL,created_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE job_source_identities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      verified_at INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
      reserved INTEGER NOT NULL CHECK(reserved IN (0,1))
    ) STRICT;
CREATE TABLE justup_company_aliases(source_company_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,official_domain TEXT NOT NULL,verified_at INTEGER NOT NULL) STRICT;
CREATE TABLE justup_company_follows(owner_id TEXT NOT NULL,company_id TEXT NOT NULL,followed INTEGER NOT NULL CHECK(followed IN (0,1)),followed_at INTEGER NOT NULL,PRIMARY KEY(owner_id,company_id)) STRICT;
CREATE TABLE justup_follow_revisions(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
CREATE TABLE justup_preferences(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,interface_locale TEXT) STRICT;
CREATE TABLE justup_processing_admission(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),source_commit TEXT,build_identity TEXT,policy_version TEXT,private_generation TEXT,checked_at INTEGER NOT NULL, policy_scope TEXT) STRICT;
CREATE TABLE justup_recovered_drafts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE justup_requested_companies(id TEXT PRIMARY KEY,domain TEXT NOT NULL UNIQUE,data_json TEXT NOT NULL) STRICT;
CREATE TABLE justup_search_options(owner_id TEXT NOT NULL,search_id TEXT NOT NULL,options_json TEXT NOT NULL,PRIMARY KEY(owner_id,search_id)) STRICT;
CREATE TABLE justup_viewed (owner_id TEXT NOT NULL, job_id TEXT NOT NULL, first_viewed_at INTEGER NOT NULL, PRIMARY KEY(owner_id,job_id)) STRICT;
CREATE TABLE justup_visitors (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    submissions INTEGER NOT NULL DEFAULT 0, handed_to TEXT, handed_at INTEGER, matching_tasks INTEGER NOT NULL DEFAULT 0, interface_locale TEXT NOT NULL DEFAULT 'en') STRICT;
CREATE TABLE justup_workspaces (owner_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX access_billing_events_account ON access_billing_events(account_id);
CREATE INDEX access_subscriptions_account ON access_subscriptions(account_id);
CREATE INDEX auth_accounts_deadline ON auth_accounts(account_expires_at);
CREATE INDEX auth_accounts_expiry ON auth_accounts(created_at);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX demo_company_requests_owner ON demo_company_requests(owner_id);
CREATE INDEX demo_jobs_company ON demo_jobs(company_id);
CREATE INDEX demo_jobs_order ON demo_jobs(first_seen_at DESC, id);
CREATE INDEX demo_match_cache_owner ON demo_match_cache(owner_id);
CREATE INDEX demo_searches_owner ON demo_searches(owner_id);
CREATE INDEX demo_tasks_owner ON demo_tasks(owner_id);
CREATE INDEX demo_tasks_queue ON demo_tasks(status,created_at);
CREATE INDEX job_source_identities_company ON job_source_identities(company_id);
CREATE INDEX justup_company_aliases_domain ON justup_company_aliases(official_domain);
CREATE INDEX justup_company_aliases_public ON justup_company_aliases(company_id);
CREATE INDEX justup_recovered_drafts_owner ON justup_recovered_drafts(owner_id);
CREATE TRIGGER hiring_wire_period_immutable BEFORE UPDATE ON hiring_wire_editions WHEN NEW.period_id IS NOT OLD.period_id OR NEW.period_end IS NOT OLD.period_end
    BEGIN SELECT RAISE(ABORT,'Hiring Wire periods are immutable'); END;
CREATE TRIGGER hiring_wire_published_immutable BEFORE UPDATE ON hiring_wire_editions WHEN OLD.status='published'
    BEGIN SELECT RAISE(ABORT,'Published Hiring Wire editions are immutable'); END;
CREATE TRIGGER hiring_wire_snapshot_immutable BEFORE UPDATE ON hiring_wire_editions
    WHEN OLD.snapshot_json IS NOT NULL AND (NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256 OR NEW.facts_json IS NOT OLD.facts_json OR NEW.prior_json IS NOT OLD.prior_json OR NEW.period_end IS NOT OLD.period_end)
    BEGIN SELECT RAISE(ABORT,'Hiring Wire snapshots are immutable'); END;
CREATE TABLE hiring_wire_schedule (
    period_end TEXT PRIMARY KEY,task_id TEXT,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
    next_attempt INTEGER NOT NULL,outcome TEXT NOT NULL
  ) STRICT;
PRAGMA user_version=1;
