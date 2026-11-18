// Jobseek's private receipt protocol and durable board evidence.
// Operator approval binds exact source bytes to one Justup company and scope.
import {createHash} from 'node:crypto';

export const MONITORING_INPUT_LIMIT = 128 * 1024;
const DAY = 86_400_000;
const RECEIPT_LIMIT = 4096;
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNAVAILABLE = new Set(['scope_changed', 'scope_inactive', 'no_complete_check', 'invalid_schedule', 'expired_check']);
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);
export const validMonitoringCompanyId = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !/[\x00-\x1f\x7f/\\]/u.test(value);
const fail = () => { throw Object.assign(new Error('Monitoring evidence could not be verified.'), {code:'invalid_input', status:400}); };

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
      || !fields.every(key => Object.hasOwn(value, key))) fail();
  return value;
}

function timestamp(value) {
  if (!valid(TIMESTAMP, value)) fail();
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString() !== value) fail();
  return at;
}

function parse(buffer) {
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer)); }
  catch { return fail(); }
}

function readReceipt(entry, sourceCompanyId, now) {
  exact(entry, ['boardId', 'revision', 'sha256', 'receiptBase64']);
  if (!valid(UUID, entry.boardId) || !valid(UUID, entry.revision) || !valid(SHA, entry.sha256)
      || typeof entry.receiptBase64 !== 'string' || entry.receiptBase64.length > 4 * Math.ceil(RECEIPT_LIMIT / 3)) fail();
  const raw = Buffer.from(entry.receiptBase64, 'base64');
  if (raw.length > RECEIPT_LIMIT || raw.toString('base64') !== entry.receiptBase64
      || createHash('sha256').update(raw).digest('hex') !== entry.sha256) fail();
  const value = exact(parse(raw), ['schemaVersion', 'sourceVersion', 'companyId', 'boardId', 'revision',
    'observedAt', 'state', 'reason', 'verifiedAt', 'expiresAt']);
  if (!raw.equals(Buffer.from(JSON.stringify(value) + '\n')) || value.schemaVersion !== 1 || value.sourceVersion !== 'jobseek-monitoring-v1'
      || value.companyId !== sourceCompanyId || value.boardId !== entry.boardId || value.revision !== entry.revision) fail();
  const observedAt = timestamp(value.observedAt);
  if (observedAt > now || now - observedAt >= DAY) fail();
  const receipt = {boardId:entry.boardId, revision:entry.revision, sha256:entry.sha256, observedAt, verifiedAt:null, expiresAt:null};
  if (value.state === 'unavailable') {
    if (!UNAVAILABLE.has(value.reason) || value.verifiedAt !== null || value.expiresAt !== null) fail();
    return receipt;
  }
  if (value.state !== 'current' || value.reason !== null) fail();
  const verifiedAt = timestamp(value.verifiedAt), expiresAt = timestamp(value.expiresAt);
  if (verifiedAt > observedAt || expiresAt <= now || expiresAt - verifiedAt > DAY) fail();
  return {...receipt, verifiedAt, expiresAt};
}

export function readMonitoringApproval(raw, now) {
  if (!Buffer.isBuffer(raw) || raw.length > MONITORING_INPUT_LIMIT || !Number.isSafeInteger(now)) fail();
  const value = exact(parse(raw), ['schemaVersion', 'companyId', 'expectedRevision', 'sourceCompanyId', 'receipts', 'requests']);
  if (value.schemaVersion !== 1 || !validMonitoringCompanyId(value.companyId) || !valid(UUID, value.sourceCompanyId)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
      || !Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > 32
      || !Array.isArray(value.requests) || value.requests.length > 50) fail();
  const receipts = value.receipts.map(entry => readReceipt(entry, value.sourceCompanyId, now));
  if (new Set(receipts.map(entry => entry.boardId)).size !== receipts.length) fail();
  for (const request of value.requests) {
    exact(request, ['id', 'scope']);
    if (!valid(UUID, request.id) || (request.scope !== null &&
        (typeof request.scope !== 'string' || request.scope.length < 1 || request.scope.length > 500))) fail();
  }
  if (new Set(value.requests.map(request => request.id)).size !== value.requests.length
      || (value.requests.length && receipts.some(receipt => receipt.expiresAt === null))) fail();
  return {companyId:value.companyId, expectedRevision:value.expectedRevision, sourceCompanyId:value.sourceCompanyId,
    receipts, requests:value.requests};
}

export function initializeCompanyMonitoring(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS justup_company_monitoring (
    board_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, source_company_id TEXT NOT NULL,
    scope_revision TEXT NOT NULL, sha256 TEXT NOT NULL, observed_at INTEGER NOT NULL,
    verified_at INTEGER, expires_at INTEGER,
    CHECK((verified_at IS NULL AND expires_at IS NULL)
      OR (verified_at IS NOT NULL AND expires_at IS NOT NULL AND verified_at<=observed_at AND observed_at<expires_at))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS justup_company_monitoring_company ON justup_company_monitoring(company_id);`);
}

export function monitoringStatus(rows, at, bindings = null) {
  if (bindings !== null && !bindings.length) return null;
  const selected = bindings === null ? rows : bindings.flatMap(([boardId, revision]) => {
    const found = rows.find(row => row.board_id === boardId && row.scope_revision === revision);
    return found ? [found] : [];
  });
  const live = selected.filter(row => row.observed_at <= at && row.expires_at !== null && at < row.expires_at);
  if (live.length && (bindings === null || live.length === bindings.length)) {
    return {state:'monitoring', reason:'source_verified', nextAction:'view_positions',
      updatedAt:new Date(Math.max(...live.map(row => row.observed_at))).toISOString(),
      verifiedAt:new Date((bindings === null ? Math.max : Math.min)(...live.map(row => row.verified_at))).toISOString(),
      expiresAt:new Date((bindings === null ? Math.max : Math.min)(...live.map(row => row.expires_at))).toISOString()};
  }
  if (bindings !== null || selected.length) {
    return {state:'blocked', reason:'source_evidence_unavailable', nextAction:'retry_later',
      updatedAt:selected.length ? new Date(Math.max(...selected.map(row => row.observed_at))).toISOString() : null};
  }
  return null;
}
