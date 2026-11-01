// Disk-backed epoch transition contracts. The legacy DDL is a frozen independent
// fixture, populated with synthetic private/product state and nonzero spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth.mjs';
import { createTasks } from './tasks.mjs';
import { openStore } from './store.mjs';
import { migrateDatabaseFile, migrateSchemaV1, assertCurrentSchema } from './schema.mjs';

const AT=1793448000000, PASSWORD='Synthetic migration password 123!';
const LEGACY_DDL=readFileSync(new URL('./fixtures/schema-v1.sql',import.meta.url),'utf8');
const tables=db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
function contents(db) {
  return Object.fromEntries(tables(db).map(name=>[name,db.prepare(`SELECT rowid AS __rowid__,* FROM "${name}" ORDER BY rowid`).all()
    .map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Uint8Array?{blob:Buffer.from(value).toString('hex')}:value])))]));
}
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'justup-epoch-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'application.sqlite'),db=new DatabaseSync(path);
  db.exec(LEGACY_DDL);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const auth=createAuth({db,config:{requiresInvitation:false,maxAccounts:null},now:()=>AT});
  const account=await auth.register({username:'migration-user',password:PASSWORD}),owner=account.account.id;
  const insert=(table,values)=>db.prepare(`INSERT INTO ${table} VALUES (${values.map(()=>'?').join(',')})`).run(...values);
  insert('access_identities',[owner,'verified-subject','verified-legacy',AT-30]);
  insert('access_free_periods',[owner,'legacy',AT-20,AT+100000]);
  insert('access_subscriptions',['subscription-a',owner,7,'cancelled','monthly',AT+200000,0]);
  insert('access_billing_events',['event-a','canonical-a',owner,'subscription-a',7,AT-10]);
  insert('demo_imports',['generation-original',AT-100,AT,'{"selection":"frozen"}',2,1]);
  for(const [id,active,reserved] of [['job-live',1,0],['job-closed',0,0],['evicted-closure',0,1]]) {
    insert('job_source_identities',[id,'company-source',AT-300000,AT,active,reserved]);
    if(id!=='evicted-closure')insert('demo_jobs',[id,'company-source',AT-300000,active,reserved,AT,active?null:AT-1,'evidence-'+id,'{"id":"'+id+'","preserve":"雪"}','Original body\nbytes']);
  }
  insert('demo_tasks',['leased-task',owner,'ai_match','same-retry','{"scanId":"scan-a"}',null,'running',AT-20,AT-10,AT+30000,'live-lease','worker-original',2,null]);
  insert('demo_tasks',['pending-task',owner,'search_intent','pending-retry','{"query":"Old draft"}',null,'pending',AT-10,AT-10,null,null,null,0,null]);
  insert('demo_tasks',['wire-task','__hiring_wire__','hiring_wire','edition-2026-10-26','{"periodEnd":"2026-10-26T00:00:00.000Z"}','{"editionId":"2026-10-26"}','succeeded',AT-50,AT-10,null,null,null,1,null]);
  insert('demo_tasks',['completed-task',owner,'company_resolution','completed-retry','{"requestId":"request-a"}','{"requestId":"request-a"}','succeeded',AT-40,AT-10,null,null,null,1,null]);
  insert('demo_company_requests',['request-a',owner,'Original company','example.org','https://example.org/careers','worldwide','fingerprint-a','accepted','{"companyId":"company-canonical"}',3,null,'completed-task',AT-100,'accept-receipt']);
  insert('demo_company_request_keys',[owner,'request-retry','{"input":"Original company"}','request-a']);
  insert('demo_company_evidence',['request-a',owner,3,'{"source":"official","proof":"frozen"}']);
  insert('demo_company_request_tasks',[owner,'request-a','completed-task']);
  insert('demo_searches',['search-a',owner,4,'{"id":"search-a","revision":4}','{"query":"Pending edit"}','pending-task',AT-100,AT-10]);
  insert('demo_search_submissions',[owner,'search-retry','search-a','input-hash','pending-task']);
  insert('demo_search_proposals',['proposal-a',owner,'search-a',4,'pending-task','{"proposalId":"proposal-a","text":"preserve"}']);
  insert('demo_search_cursors',['cursor-a',owner,'search-a',4,'generation-original','access-hash',9,AT]);
  insert('demo_search_delegate_cursors',['delegate-a',owner,'search-a',4,'generation-original','access-hash','opaque-token-original',AT]);
  insert('demo_match_scans',['scan-a',owner,'search-a',4,'config-hash','condition-hash','Original condition','classifier-v1','generation-original','access-hash','working',null,AT+1000,'leased-task',2,5,AT-100,AT-10,'hidden','membership-hash']);
  insert('demo_match_jobs',['scan-a',1,'job-live','evidence-a','cache-a','accepted']);
  insert('demo_match_cursors',['match-token','scan-a',7,AT]);
  insert('demo_match_cache',['cache-a',owner,'condition-hash','evidence-a','classifier-v1','accepted',AT-10,AT+10000]);
  insert('demo_match_cache_links',[owner,'search-a','cache-a']);
  for(const [scope,key] of [['account',owner],['project','project-original']])insert('demo_jev_usage',[scope,key,AT-1000,9,576000,0,24192000,2]);
  insert('demo_jev_reservations',['reservation-original',owner,'project-original',AT-1000,64000,0,2688000,'ambiguous',AT-10]);
  insert('justup_company_aliases',['company-source','company-canonical','example.org',AT]);
  insert('justup_requested_companies',['company-canonical','example.org','{"id":"company-canonical"}']);
  insert('justup_company_follows',[owner,'company-canonical',1,AT-10]);
  insert('justup_company_follows',[owner,'negative-follow',0,AT-20]);
  insert('justup_follow_revisions',[owner,8]);insert('justup_preferences',[owner,7,'fr']);
  insert('justup_search_options',[owner,'search-a','{"followedOnly":true,"postingLanguages":["fr"]}']);
  insert('justup_visitors',['visitor:original','visitor-token-hash',AT-100,AT+10000,2,null,null,3,'fr']);
  insert('justup_workspaces',[owner,'{"activeSearchId":"search-a","order":["search-a"]}',AT,9]);
  insert('justup_recovered_drafts',['recovered-a',owner,'Restored pending draft',AT]);
  insert('justup_viewed',[owner,'job-live',AT-10]);
  insert('justup_processing_admission',[1,1,'a'.repeat(40),'old-build','policy-original','private-generation-original',AT,'{"fr":{"locale":"fr","reviewed":true,"version":"exact"}}']);
  insert('hiring_wire_cleanup_halt',[1,'wire-task',AT,'cleanup_unproven']);
  insert('hiring_wire_editions',['2026-10-26','2026-10-26T00:00:00.000Z','published',AT-100,AT,'{"snapshot":"frozen"}','snapshot-hash','{"facts":"frozen"}','[]','{"selection":"frozen"}','{"execution":"frozen"}','{"recipe":"frozen"}','{"public":"frozen"}','published']);
  insert('hiring_wire_executions',['execution-original','2026-10-26','wire-task',AT-100,AT,'published',null]);
  insert('hiring_wire_tool_versions',[7,'recipe-original','recipe-hash','{"version":1}',AT]);
  insert('hiring_wire_schedule',['2026-10-26T00:00:00.000Z','wire-task',2,AT+900000,'published']);
  const ledger=join(dir,'jev.jsonl');writeFileSync(ledger,'{"schemaVersion":1,"kind":"approval","resourceSlug":"demo-jev-evaluation-budget","resourceId":"historical-fixed"}\n{"kind":"reserve","reservedNanodollars":2688000,"previousHash":"unchanged"}\n');
  const generation=join(dir,'private-generation');writeFileSync(generation,'00000000-0000-4000-8000-000000000000\n');
  return {db,path,dir,ledger,generation,account,owner};
}

test('offline rename preserves all disk rows, identities, leases, spend and untouched proof/history, then reopens',async t=>{
  const f=await fixture(t),before=contents(f.db),ledger=readFileSync(f.ledger),generation=readFileSync(f.generation);
  assert(Object.values(before).every(rows=>rows.length>0));
  const sequence=f.db.prepare('SELECT * FROM sqlite_sequence').all();f.db.close();
  assert.deepEqual(migrateDatabaseFile(f.path),{schemaVersion:2,previousSchemaVersion:1,migratedTables:19});
  const db=new DatabaseSync(f.path);t.after(()=>db.close());assert.equal(assertCurrentSchema(db),2);
  const expected=Object.fromEntries(Object.entries(before).map(([name,rows])=>[name.replace(/^demo_/,'justup_'),rows]));
  assert.deepEqual(contents(db),expected);assert.deepEqual(db.prepare('SELECT * FROM sqlite_sequence').all(),sequence);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'demo_%'").get().n,0);
  assert.deepEqual(readFileSync(f.ledger),ledger);assert.deepEqual(readFileSync(f.generation),generation);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA foreign_key_list(justup_match_jobs)').get().table,'justup_match_scans');
  assert.throws(()=>db.prepare("UPDATE hiring_wire_editions SET public_json='{}'").run(),/immutable/);
  const auth=createAuth({db,config:{requiresInvitation:false},now:()=>AT});assert.equal(auth.session(f.account.token).account.id,f.owner);
  assert.equal((await auth.login({username:'migration-user',password:PASSWORD})).account.id,f.owner);
  assert.equal(auth.session(f.account.token).access.kind,'cancelled');
  const tasks=createTasks({db,now:()=>AT});
  assert.equal(tasks.get(f.owner,'leased-task').leaseToken,'live-lease');
  assert.equal(tasks.enqueue({ownerId:f.owner,kind:'ai_match',requestKey:'same-retry',payload:{scanId:'scan-a'}}).id,'leased-task');
  assert.throws(()=>tasks.enqueue({ownerId:f.owner,kind:'ai_match',requestKey:'same-retry',payload:{scanId:'changed'}}),{code:'idempotency_conflict'});
  assert.throws(()=>migrateSchemaV1(db),/schema/);
});

test('failure midway through rename rolls back names, data and epoch durably',async t=>{
  const f=await fixture(t),before=contents(f.db),exec=f.db.exec.bind(f.db);let renames=0;
  f.db.exec=sql=>{exec(sql);if(sql.startsWith('ALTER TABLE')&&++renames===6)throw new Error('simulated interruption');};
  assert.throws(()=>migrateSchemaV1(f.db),/simulated interruption/);assert.equal(f.db.isTransaction,false);f.db.close();
  const db=new DatabaseSync(f.path);t.after(()=>db.close());assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(contents(db),before);
});

test('mixed names, partial groups, incorrect columns, unknown old objects and corrupt foreign keys fail without migration',async t=>{
  const cases=[
    "CREATE TABLE justup_jobs(id TEXT)", "DROP TABLE demo_search_proposals", "ALTER TABLE demo_tasks ADD COLUMN unexpected TEXT",
    "CREATE TABLE demo_unknown(id TEXT)", "PRAGMA foreign_keys=OFF; INSERT INTO demo_match_jobs VALUES('missing',99,'ghost','hash','cache',NULL)",
  ];
  for(const sql of cases){await t.test(sql,async t=>{const f=await fixture(t);f.db.exec(sql);const before=contents(f.db);assert.throws(()=>migrateSchemaV1(f.db),/schema/);assert.deepEqual(contents(f.db),before);assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,1);f.db.close();});}
});

test('active SQLite writer blocks migration; application writer quiescence is a separate operator contract',async t=>{
  const f=await fixture(t),writer=new DatabaseSync(f.path);writer.exec('BEGIN IMMEDIATE');
  assert.throws(()=>migrateSchemaV1(f.db),/locked|busy/);assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,1);
  writer.exec('ROLLBACK');writer.close();migrateSchemaV1(f.db);assert.equal(assertCurrentSchema(f.db),2);f.db.close();
});

test('process death during the rename leaves the previous complete epoch recoverable on disk',{timeout:10000},async t=>{
  const f=await fixture(t),before=contents(f.db);f.db.close();
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    import {migrateSchemaV1} from ${JSON.stringify(new URL('./schema.mjs',import.meta.url).href)};
    const db=new DatabaseSync(process.argv[1]),exec=db.exec.bind(db);let count=0;
    db.exec=sql=>{exec(sql);if(sql.startsWith('ALTER TABLE')&&++count===6){process.stdout.write('inside-transaction\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};
    migrateSchemaV1(db);
  `,f.path],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const db=new DatabaseSync(f.path);t.after(()=>db.close());assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(contents(db),before);
});

test('an import-only epoch-one database upgrades without inventing optional feature state',t=>{
  const dir=mkdtempSync(join(tmpdir(),'justup-core-epoch-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'core.sqlite'),db=new DatabaseSync(path);
  db.exec(LEGACY_DDL);
  const retain=new Set(['demo_imports','demo_jobs','job_source_identities']);
  db.exec('PRAGMA foreign_keys=OFF');
  for(const name of tables(db))if(!retain.has(name))db.exec(`DROP TABLE "${name}"`);
  const before=contents(db);db.close();
  assert.deepEqual(migrateDatabaseFile(path),{schemaVersion:2,previousSchemaVersion:1,migratedTables:2});
  const reopened=new DatabaseSync(path);t.after(()=>reopened.close());assert.equal(assertCurrentSchema(reopened),2);
  assert.deepEqual(contents(reopened),Object.fromEntries(Object.entries(before).map(([name,rows])=>[name.replace(/^demo_/,'justup_'),rows])));
});

test('normal startup initializes empty epoch two and refuses old or inconsistent populated epochs',async t=>{
  const fresh=openStore();assert.equal(assertCurrentSchema(fresh.db),2);fresh.close();
  const f=await fixture(t),before=contents(f.db);
  assert.throws(()=>openStore(f.path),/offline migration/);assert.deepEqual(contents(f.db),before);assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,1);
  f.db.exec('PRAGMA user_version=0');assert.throws(()=>openStore(f.path),/schema/);
  f.db.exec('PRAGMA user_version=2');assert.throws(()=>openStore(f.path),/schema/);
  f.db.exec('PRAGMA user_version=3');assert.throws(()=>openStore(f.path),/schema/);f.db.close();
});
