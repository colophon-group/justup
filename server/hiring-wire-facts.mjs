// Immutable Hiring Wire fact compiler. Only an authoritative history projection
// can establish comparable coverage; a current listing snapshot cannot do so.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const WIRE_FACT_VERSION = 'hiring-wire-facts-v1';
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
export const WIRE_PUBLIC_BOUNDS=Object.freeze({companyName:200,companyUrl:2048,headline:320,items:6,editionBytes:16_384});
export const METHOD = 'Distinct newly observed listings on the same continuously tracked career pages; listing activity does not measure hires or headcount.';
export const wireError = code => Object.assign(new Error('Hiring Wire could not be prepared.'), {code});
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw wireError('invalid_output');
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function bounded(value, max = 65_536) {
  const bytes = JSON.stringify(value);
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > max) throw wireError('invalid_output');
  return JSON.parse(bytes);
}
export function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw wireError('invalid_output');
  return Date.parse(value);
}
export function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) throw wireError('invalid_output');
  return value;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f<>]/u.test(value)) throw wireError('invalid_output');
  return value;
}
function companyUrl(value) {
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\?#]/u.test(value)
    ||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)||!/^https:\/\//iu.test(value)
    ||/^https:\/\/[^/]*@/iu.test(value))throw wireError('invalid_output');
  let url; try { url = new URL(value); } catch { throw wireError('invalid_output'); }
  if (url.href.length>2048 || url.hostname.length>253 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search || isIP(url.hostname)
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(url.hostname) || /(?:^|\.)(?:localhost|local|localdomain|internal|invalid|test|home|lan|private|corp|intranet|arpa|onion)$/u.test(url.hostname)
    || url.hostname.split('.').some(part => part.length>63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part))) throw wireError('invalid_output');
  return url.href;
}
export function periodFor(periodEnd) {
  const end = iso(periodEnd);
  if (new Date(end).getUTCDay() !== 1 || end % DAY !== 0) throw wireError('invalid_input');
  return {id: periodEnd.slice(0,10), start: new Date(end-WEEK).toISOString(), end: periodEnd, previousStart: new Date(end-2*WEEK).toISOString()};
}

export function compileWireSnapshot(input, {periodEnd, now = Date.now()} = {}) {
  const value = bounded(input, 16 * 1024 * 1024), period = periodFor(periodEnd), end = iso(period.end), start = iso(period.previousStart);
  exact(value, ['schemaVersion','sourceVersion','snapshotId','asOf','generatedAt','companies','scopes','postings']);
  if (value.schemaVersion !== 1 || value.asOf !== periodEnd) throw wireError('invalid_output');
  token(value.sourceVersion); token(value.snapshotId);
  const generatedAt = iso(value.generatedAt);
  if (generatedAt < end || generatedAt > now || now-generatedAt > DAY || generatedAt-end > DAY) throw wireError('dependency_unavailable');
  if (!Array.isArray(value.companies) || value.companies.length > 500 || !Array.isArray(value.scopes) || value.scopes.length > 2000 || !Array.isArray(value.postings) || value.postings.length > 100_000) throw wireError('invalid_output');
  const companies = new Map(), scopes = new Map(), suppressed = [];
  for (const company of value.companies) {
    exact(company, ['id','name','url']); token(company.id); label(company.name);
    if (companies.has(company.id)) throw wireError('invalid_output');
    companies.set(company.id, {...company,url:companyUrl(company.url)});
  }
  for (const scope of value.scopes) {
    exact(scope, ['id','companyId','revision','trackedSince','lastVerifiedAt','coverage']);
    token(scope.id); token(scope.revision);
    if (!companies.has(scope.companyId) || scopes.has(scope.id) || !Array.isArray(scope.coverage) || scope.coverage.length > 128) throw wireError('invalid_output');
    const tracked = iso(scope.trackedSince), verified = scope.lastVerifiedAt===null?null:iso(scope.lastVerifiedAt);
    if (tracked > end || verified!==null&&(verified > generatedAt || tracked > verified)) throw wireError('invalid_output');
    let reason = verified===null?'never_verified_scope':tracked > start ? 'new_scope' : verified < end ? 'stale_scope' : null;
    let cursor = start;
    for (const interval of scope.coverage) {
      exact(interval,['start','end','state']); const a=iso(interval.start), b=iso(interval.end);
      if (a >= b || a < start || b > end || !['complete','interrupted','unknown'].includes(interval.state)) throw wireError('invalid_output');
      if (a !== cursor) reason ??= 'insufficient_history';
      if (interval.state !== 'complete') reason ??= 'interrupted_scope';
      cursor = b;
    }
    if (cursor !== end) reason ??= 'insufficient_history';
    scopes.set(scope.id, {...scope, eligible:reason===null});
    if (reason) suppressed.push({scopeId:scope.id,reason});
  }
  const identities = new Map(), observations = new Map();
  for (const posting of value.postings) {
    exact(posting,['id','scopeId','firstObserved']); token(posting.id);
    const scope=scopes.get(posting.scopeId), first=iso(posting.firstObserved);
    if (!scope || first < start || first >= end) throw wireError('invalid_output');
    const identity=identities.get(posting.id);
    if (identity && (identity.firstObserved!==posting.firstObserved || identity.companyId!==scope.companyId)) throw wireError('invalid_output');
    identities.set(posting.id,{firstObserved:posting.firstObserved,companyId:scope.companyId});
    if (scope.eligible) observations.set(posting.id,{companyId:scope.companyId,first});
  }
  const counts = new Map();
  for (const scope of scopes.values()) if (scope.eligible && !counts.has(scope.companyId)) counts.set(scope.companyId,{current:0,previous:0,scopeCount:0});
  for (const scope of scopes.values()) if (scope.eligible) counts.get(scope.companyId).scopeCount++;
  for (const posting of observations.values()) counts.get(posting.companyId)[posting.first >= end-WEEK ? 'current' : 'previous']++;
  const facts = [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([id,count])=>({
    id:digest({periodEnd,companyId:id,version:WIRE_FACT_VERSION}).slice(0,32), company:companies.get(id), ...count,
    change:count.current-count.previous, percentageChange:count.previous===0?null:Math.round((count.current-count.previous)/count.previous*1000)/10
  }));
  return {period,snapshot:value,snapshotSha256:digest(value),factsVersion:WIRE_FACT_VERSION,facts,suppressed};
}

export function validateWireSelection(data, facts, snapshotId) {
  bounded(data,8192); exact(data,['snapshotId','items']);
  if (data.snapshotId !== snapshotId || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 6) throw wireError('invalid_output');
  const seen=new Set();
  return data.items.map(item=>{
    exact(item,['factId','angle']);
    const fact=facts.find(f=>f.id===item.factId);
    if (!fact || seen.has(fact.company.id) || fact.current+fact.previous===0) throw wireError('invalid_output');
    seen.add(fact.company.id);
    const angle=fact.previous===0?'new_activity':fact.change>0?'increase':fact.change<0?'decrease':'steady';
    if(item.angle!==angle && item.angle!=='counts') throw wireError('invalid_output');
    return {...item};
  });
}

export function renderWireItems(selection, facts) {
  return selection.map(item=>{
    const fact=facts.find(f=>f.id===item.factId), {current,previous,change,percentageChange}=fact;
    // Free-form claims, links and numbers are never accepted from a model.
    const headlines={
      counts:`${fact.company.name}: ${current} newly observed listings, compared with ${previous} the previous week`,
      increase:`${fact.company.name}: newly observed listings rose from ${previous} to ${current}`,
      decrease:`${fact.company.name}: newly observed listings fell from ${previous} to ${current}`,
      steady:`${fact.company.name}: newly observed listings held at ${current}`,
      new_activity:`${fact.company.name}: ${current} newly observed listings, after zero the previous week`
    };
    const headline=headlines[item.angle];
    if(typeof headline!=='string' || headline.length>WIRE_PUBLIC_BOUNDS.headline)throw wireError('invalid_output');
    return {company:{...fact.company},headline,activity:{current,previous,change,percentageChange},scope:'Comparable career pages'};
  });
}
