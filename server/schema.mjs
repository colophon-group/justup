// Application SQLite epoch and the explicit, forward-only product naming migration.
// Read before changing launch compatibility, backups or persisted product names.
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

export const SCHEMA_VERSION = 2;
export const LEGACY_TABLE_NAMES = Object.freeze([
  'imports', 'jobs', 'tasks', 'company_requests', 'company_request_keys',
  'company_request_tasks', 'company_evidence', 'searches', 'search_submissions',
  'search_proposals', 'search_cursors', 'search_delegate_cursors', 'match_scans',
  'match_jobs', 'match_cursors', 'match_cache', 'match_cache_links', 'jev_usage', 'jev_reservations',
]);
const INDEXES = Object.freeze({
  jobs_order: ['jobs', 'first_seen_at DESC, id'], jobs_company: ['jobs', 'company_id'],
  tasks_owner: ['tasks', 'owner_id'], tasks_queue: ['tasks', 'status,created_at'],
  company_requests_owner: ['company_requests', 'owner_id'], searches_owner: ['searches', 'owner_id'],
  match_cache_owner: ['match_cache', 'owner_id'],
});
// Frozen epoch-1 column contracts: [name, SQLite type, not-null, primary-key order,
// default SQL]. This is validation for the one migration, never an initializer.
const LEGACY_COLUMNS = {
  "demo_company_evidence": [["request_id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["preview_revision","INTEGER",1,0,null],["provenance_json","TEXT",1,0,null]],
  "demo_company_request_keys": [["owner_id","TEXT",1,1,null],["request_key","TEXT",1,2,null],["input_json","TEXT",1,0,null],["request_id","TEXT",1,0,null]],
  "demo_company_request_tasks": [["owner_id","TEXT",1,1,null],["request_id","TEXT",1,2,null],["task_id","TEXT",1,3,null]],
  "demo_company_requests": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["input_text","TEXT",1,0,null],["domain","TEXT",0,0,null],["career_url","TEXT",0,0,null],["scope","TEXT",0,0,null],["fingerprint","TEXT",1,0,null],["status","TEXT",1,0,null],["candidate_json","TEXT",0,0,null],["preview_revision","INTEGER",1,0,null],["clarification","TEXT",0,0,null],["task_id","TEXT",0,0,null],["created_at","INTEGER",1,0,null],["accept_key","TEXT",0,0,null]],
  "demo_imports": [["generation","TEXT",1,1,null],["snapshot_at","INTEGER",1,0,null],["verified_at","INTEGER",1,0,null],["selection_json","TEXT",1,0,null],["imported_count","INTEGER",1,0,null],["unknown_count","INTEGER",1,0,null]],
  "demo_jev_reservations": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["project_id","TEXT",1,0,null],["window_start","INTEGER",1,0,null],["input_tokens","INTEGER",1,0,null],["output_tokens","INTEGER",1,0,null],["cost_nano","INTEGER",1,0,null],["state","TEXT",1,0,null],["created_at","INTEGER",1,0,null]],
  "demo_jev_usage": [["scope","TEXT",1,1,null],["scope_key","TEXT",1,2,null],["window_start","INTEGER",1,3,null],["calls","INTEGER",1,0,null],["input_tokens","INTEGER",1,0,null],["output_tokens","INTEGER",1,0,null],["cost_nano","INTEGER",1,0,null],["ambiguous","INTEGER",1,0,"0"]],
  "demo_jobs": [["id","TEXT",1,1,null],["company_id","TEXT",1,0,null],["first_seen_at","INTEGER",1,0,null],["active","INTEGER",1,0,null],["reserved","INTEGER",1,0,null],["verified_at","INTEGER",1,0,null],["closed_observed_at","INTEGER",0,0,null],["evidence_hash","TEXT",0,0,null],["data_json","TEXT",1,0,null],["body_text","TEXT",0,0,null]],
  "demo_match_cache": [["cache_key","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["condition_hash","TEXT",1,0,null],["evidence_hash","TEXT",1,0,null],["classifier","TEXT",1,0,null],["decision","TEXT",1,0,null],["created_at","INTEGER",1,0,null],["expires_at","INTEGER",1,0,null]],
  "demo_match_cache_links": [["owner_id","TEXT",1,1,null],["search_id","TEXT",1,2,null],["cache_key","TEXT",1,3,null]],
  "demo_match_cursors": [["token_hash","TEXT",1,1,null],["scan_id","TEXT",1,0,null],["position","INTEGER",1,0,null],["created_at","INTEGER",1,0,null]],
  "demo_match_jobs": [["scan_id","TEXT",1,1,null],["position","INTEGER",1,2,null],["job_id","TEXT",1,0,null],["evidence_hash","TEXT",1,0,null],["cache_key","TEXT",1,0,null],["decision","TEXT",0,0,null]],
  "demo_match_scans": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["search_id","TEXT",1,0,null],["revision","INTEGER",1,0,null],["config_hash","TEXT",1,0,null],["condition_hash","TEXT",1,0,null],["condition","TEXT",1,0,null],["classifier","TEXT",1,0,null],["generation","TEXT",1,0,null],["access_hash","TEXT",1,0,null],["state","TEXT",1,0,null],["pause_code","TEXT",0,0,null],["retry_at","INTEGER",0,0,null],["task_id","TEXT",0,0,null],["round","INTEGER",1,0,"0"],["delivered","INTEGER",1,0,"0"],["created_at","INTEGER",1,0,null],["updated_at","INTEGER",1,0,null],["cohort","TEXT",1,0,"'visible'"],["membership_hash","TEXT",1,0,"''"]],
  "demo_search_cursors": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["search_id","TEXT",1,0,null],["revision","INTEGER",1,0,null],["generation","TEXT",0,0,null],["access_hash","TEXT",1,0,null],["position","INTEGER",1,0,null],["created_at","INTEGER",1,0,null]],
  "demo_search_delegate_cursors": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["search_id","TEXT",1,0,null],["revision","INTEGER",1,0,null],["generation","TEXT",0,0,null],["access_hash","TEXT",1,0,null],["delegate_cursor","TEXT",0,0,null],["created_at","INTEGER",1,0,null]],
  "demo_search_proposals": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["search_id","TEXT",1,0,null],["expected_revision","INTEGER",1,0,null],["task_id","TEXT",1,0,null],["proposal_json","TEXT",1,0,null]],
  "demo_search_submissions": [["owner_id","TEXT",1,1,null],["request_key","TEXT",1,2,null],["search_id","TEXT",1,0,null],["input_hash","TEXT",1,0,null],["task_id","TEXT",1,0,null]],
  "demo_searches": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["revision","INTEGER",1,0,"0"],["accepted_json","TEXT",0,0,null],["draft_json","TEXT",0,0,null],["task_id","TEXT",0,0,null],["created_at","INTEGER",1,0,null],["updated_at","INTEGER",1,0,null]],
  "demo_tasks": [["id","TEXT",1,1,null],["owner_id","TEXT",1,0,null],["kind","TEXT",1,0,null],["request_key","TEXT",1,0,null],["payload_json","TEXT",1,0,null],["output_json","TEXT",0,0,null],["status","TEXT",1,0,null],["created_at","INTEGER",1,0,null],["updated_at","INTEGER",1,0,null],["lease_until","INTEGER",0,0,null],["lease_token","TEXT",0,0,null],["worker_id","TEXT",0,0,null],["attempts","INTEGER",1,0,"0"],["error_code","TEXT",0,0,null]],
};
const LEGACY_UNIQUE = {
  demo_tasks: [['owner_id','kind','request_key']], demo_company_requests: [['owner_id','fingerprint']],
  demo_match_scans: [['owner_id','search_id','revision','config_hash','classifier','generation','access_hash']],
  demo_match_jobs: [['scan_id','job_id']],
};
const LEGACY_FOREIGN_KEYS = {
  demo_match_jobs: [['scan_id','id','demo_match_scans','NO ACTION','CASCADE','NONE']],
  demo_match_cursors: [['scan_id','id','demo_match_scans','NO ACTION','CASCADE','NONE']],
  demo_match_cache_links: [['cache_key','cache_key','demo_match_cache','NO ACTION','CASCADE','NONE']],
};
const GROUPS = [
  ['imports','jobs'], ['tasks'], ['company_requests','company_request_keys','company_request_tasks','company_evidence'],
  ['searches','search_submissions','search_proposals','search_cursors','search_delegate_cursors'],
  ['match_scans','match_jobs','match_cursors','match_cache','match_cache_links'], ['jev_usage','jev_reservations'],
];
const fail = () => { throw new Error('Unsupported or inconsistent application database schema; use the reviewed offline migration/recovery procedure.'); };
const objects = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
const version = db => db.prepare('PRAGMA user_version').get().user_version;
const quote = name => '"' + name.replaceAll('"','""') + '"';
function healthy(db) {
  if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')
      || db.prepare('PRAGMA foreign_key_check').all().length) fail();
}
export function assertCurrentSchema(db, { allowEmpty = false } = {}) {
  const rows = objects(db), epoch = version(db);
  if (allowEmpty && epoch === 0 && rows.length === 0) return 0;
  if (epoch !== SCHEMA_VERSION || rows.some(row => row.name.startsWith('demo_'))
      || !['justup_imports','justup_jobs','job_source_identities'].every(name => rows.some(row => row.type === 'table' && row.name === name))) fail();
  return epoch;
}
function legacyState(db) {
  if (version(db) !== 1 || db.isTransaction !== true) fail();
  const rows = objects(db), known = new Set(LEGACY_TABLE_NAMES.map(name => 'demo_' + name));
  const indexes = new Set(Object.keys(INDEXES).map(name => 'demo_' + name));
  for (const row of rows) {
    if (LEGACY_TABLE_NAMES.some(name => row.name === 'justup_' + name) || Object.keys(INDEXES).some(name => row.name === 'justup_' + name)) fail();
    if (row.type === 'trigger' && known.has(row.tbl_name) || row.type === 'view' && /\bdemo_/i.test(row.sql)) fail();
    if (row.name.startsWith('demo_') && !(row.type === 'table' && known.has(row.name) || row.type === 'index' && indexes.has(row.name))) fail();
  }
  const tables = new Set(rows.filter(row => row.type === 'table').map(row => row.name));
  if (tables.has('justup_visitor_admission') && tables.has('justup_processing_admission')) fail();
  if (!tables.has('demo_imports') || !tables.has('demo_jobs') || !tables.has('job_source_identities')) fail();
  for (const group of GROUPS) {
    const count = group.filter(name => tables.has('demo_' + name)).length;
    if (count !== 0 && count !== group.length) fail();
  }
  for (const name of tables) {
    if (!known.has(name)) continue;
    const actual = db.prepare(`PRAGMA table_info(${quote(name)})`).all()
      .map(({name,type,notnull,pk,dflt_value}) => [name,type,notnull,pk,dflt_value]);
    const expected = LEGACY_COLUMNS[name];
    // Earlier epoch-1 scans acquire these additive columns on their next normal
    // feature initialization. Renaming must preserve either reviewed shape.
    const baseline = name === 'demo_match_scans' ? expected.filter(column => !['cohort','membership_hash'].includes(column[0])) : expected;
    if (JSON.stringify(actual) !== JSON.stringify(expected) && JSON.stringify(actual) !== JSON.stringify(baseline)) fail();
    if (db.prepare('PRAGMA table_list').all().find(row => row.name === name)?.strict !== 1) fail();
    const unique = db.prepare(`PRAGMA index_list(${quote(name)})`).all().filter(row => row.origin === 'u')
      .map(row => db.prepare(`PRAGMA index_info(${quote(row.name)})`).all().map(column => column.name));
    if (JSON.stringify(unique) !== JSON.stringify(LEGACY_UNIQUE[name] ?? [])) fail();
    const foreign = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()
      .map(row => [row.from,row.to,row.table,row.on_update,row.on_delete,row.match]);
    if (JSON.stringify(foreign) !== JSON.stringify(LEGACY_FOREIGN_KEYS[name] ?? [])) fail();
  }
  for (const [suffix,[table,columns]] of Object.entries(INDEXES)) {
    const row = rows.find(row => row.name === 'demo_' + suffix);
    if (!tables.has('demo_' + table)) { if (row) fail(); continue; }
    const normalize = value => value.replaceAll(/\s+/g,'').toLowerCase();
    if (!row || row.type !== 'index' || row.tbl_name !== 'demo_' + table
        || normalize(row.sql) !== normalize(`CREATE INDEX demo_${suffix} ON demo_${table}(${columns})`)) fail();
  }
  healthy(db);
  return tables;
}
export function migrateSchemaV1(db) {
  if (db.isTransaction) fail();
  db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
  try {
    const tables = legacyState(db);
    for (const suffix of LEGACY_TABLE_NAMES) if (tables.has('demo_' + suffix)) db.exec(`ALTER TABLE demo_${suffix} RENAME TO justup_${suffix}`);
    for (const [suffix,[table,columns]] of Object.entries(INDEXES)) if (tables.has('demo_' + table)) {
      db.exec(`DROP INDEX demo_${suffix}; CREATE INDEX justup_${suffix} ON justup_${table}(${columns})`);
    }
    healthy(db);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    assertCurrentSchema(db);
    db.exec('COMMIT');
    return {schemaVersion:SCHEMA_VERSION,previousSchemaVersion:1,migratedTables:LEGACY_TABLE_NAMES.filter(name => tables.has('demo_' + name)).length};
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
export function migrateDatabaseFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
  const db = new DatabaseSync(path);
  try { return migrateSchemaV1(db); } finally { db.close(); }
}
