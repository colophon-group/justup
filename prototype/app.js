'use strict';
// API-driven edition. All account, search, request and viewed data is server-owned.
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let session = null, accountId = 'visitor', searches = [], selectedId = null, postingLanguages = new Set(), forcedReduced = false;
let searchGeneration = 0, catalogueGeneration = 0, companyGeneration = 0, sessionGeneration = 0;
let feedState = null, catalogueState = null, requestState = null, requestTimer = null, liveTimer = null, liveSource = null;
let searchMutation = null, discoveryMutation = null, requestPolls = 0, requestGeneration = 0;
const queryDrafts = new Map();
let followedOnly = false, companyFilter = 'all', pendingDeleteId = null, accountDeletionKey = JustupApi.key();
const draft = { id: null, query: '', title: 'New search' };
const current = () => searches.find(search => search.id === selectedId) || draft;
const reduced = () => forcedReduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
const capable = name => session?.capabilities?.[name] === true;
function sourceURL(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function dateText(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not reported'; }
function ageText(value) { const elapsed = Date.now() - new Date(value).getTime(); if (!Number.isFinite(elapsed)) return '—'; const minutes = Math.max(0, Math.floor(elapsed / 60000)); return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
function announce(message) { $('#announcer').textContent = message; }
function errorText(error) { return `${error.message || 'The service is unavailable.'}${error.retryAfter ? ` Try again after ${error.retryAfter} seconds.` : ''}${error.requestId ? ` Reference: ${error.requestId}.` : ''}`; }
async function runAction(action, target = $('#search-status')) { try { await action(); } catch (error) { if (error.name !== 'AbortError') { target.textContent = errorText(error); announce(target.textContent); } } }
function coverageLabel(state) { return state === 'imported_snapshot' ? 'Imported snapshot' : state === 'requested' ? 'Identity requested' : 'Coverage not reported'; }
function companyMark(company = {}) { const url = sourceURL(company.logoUrl); return url ? `<img class="mark company-logo" src="${escapeHTML(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="mark" aria-hidden="true">↗</span>'; }
function clearProtectedState() {
  searchGeneration++; catalogueGeneration++; companyGeneration++; requestGeneration++; queryDrafts.clear();
  stopLive(); clearTimeout(requestTimer);
  searchMutation = null; discoveryMutation = null; searchProposal = null; searchSubmitOwner = null;
  session = null; JustupApi.setSession(null); accountId = 'visitor'; searches = []; selectedId = null; draft.query = ''; postingLanguages = new Set(); followedOnly = false; requestState = null; feedState = null; catalogueState = null;
  $('#feed').replaceChildren(); $('#company-list').replaceChildren(); $('#company-page').replaceChildren(); $('#request-content').replaceChildren(); $('#search-tabs').replaceChildren(); $('#query').value = ''; $('#access-notice').replaceChildren(); $('#access-notice').hidden = true; $('#search-accounting').replaceChildren(); $('#settings-content').replaceChildren(); $('#sign-in-form').reset(); $('#delete-password').value = ''; $('#auth-status').textContent = ''; $('#search-status').textContent = ''; $('#live-status').textContent = '';
  postingLanguageUI.draft.clear(); $('#posting-language-chips').replaceChildren(); $('#posting-language-choices').replaceChildren();
}
async function bootstrap() {
  const generation = ++sessionGeneration;
  $('#service-notice').hidden = false; $('#service-notice').textContent = 'Connecting to the edition…';
  $('#job-search button[type=submit]').disabled = true;
  try {
    const result = await JustupApi.request('/session');
    if (generation !== sessionGeneration) return;
    if (!result || !result.capabilities || !result.access || !Object.hasOwn(result, 'user')) throw new Error('The service returned incomplete session information.');
    session = result; JustupApi.setSession(result); accountId = result.user?.id || 'visitor'; postingLanguages = new Set(result.preferences?.postingLanguages || []);
    $('#service-notice').hidden = true; $('#header-sign-in').hidden = !!result.user;
    $('#job-search button[type=submit]').disabled = !!session?.user && !capable('search');
    $('#live-label').textContent = 'LIVE EDITION';
    $('#coverage-disclosure').textContent = result.coverage ? `Imported snapshot${result.coverage.verifiedAt ? ' · verified ' + dateText(result.coverage.verifiedAt) : ''}${result.coverage.stale ? ' · refresh needed' : ''}. This demo does not imply continuous monitoring.` : 'Company coverage and import age are not reported by the service.';
    renderHiringWire(result.signals || []);
    try {
      const response = result.user ? await JustupApi.request('/searches') : { items: [] };
      if (generation !== sessionGeneration) return;
      searches = Array.isArray(response.items) ? response.items : [];
      selectedId = queryDrafts.get(null)?.trim() ? null : searches.find(search => search.status === 'ready')?.id || null;
    } catch (error) { $('#search-status').textContent = `Saved searches unavailable. ${errorText(error)}`; }
    renderSearchShell(); if (session.user && !capable('search')) $('#search-status').textContent = 'Search interpretation is unavailable right now. Your accepted searches remain available.'; route();
  } catch (error) {
    if (generation !== sessionGeneration) return;
    session = null; JustupApi.setSession(null); renderHiringWire();
    $('#live-label').textContent = 'SERVICE UNAVAILABLE';
    $('#service-notice').innerHTML = `<p>${escapeHTML(errorText(error))}</p><button class="button outline" id="retry-session">Try again</button>`;
    renderSearchShell(); if (session.user && !capable('search')) $('#search-status').textContent = 'Search interpretation is unavailable right now. Your accepted searches remain available.'; route();
  }
}
function renderSearchShell() {
  searchProposal = null; searchSubmitOwner = null;
  $('#job-search button[type=submit]').disabled = !session || (!!session.user && !capable('search'));
  $('#search-tabs').innerHTML = searches.map(search => `<div class="search-tab"><button role="tab" aria-selected="${selectedId === search.id}" data-search="${escapeHTML(search.id)}">${escapeHTML(search.title || 'Saved search')}</button><button class="tab-remove" data-delete-search="${escapeHTML(search.id)}" aria-label="Delete ${escapeHTML(search.title || 'search')}">×</button></div>`).join('');
  const search = current(); $('#query').value = queryDrafts.get(search.id) ?? search.query ?? '';
  $('#search-intro').hidden = !!search.id; $('#landing-overview').hidden = !!search.id; $('#search-results').hidden = !search.id;
  followedOnly = search.followedOnly ?? followedOnly; $('#followed-only').setAttribute('aria-pressed', String(followedOnly));
  $('#followed-only').hidden = !capable('follows');
  $$('[data-posting-languages]').forEach(button => { button.hidden = !capable('preferences'); });
  $('[data-status=followed]').hidden = !capable('follows');
  // Request submission does not imply a requested-companies catalogue endpoint.
  $('[data-status=requested]').hidden = true;
  renderSearchAccounting(search); renderPostingLanguageControls(); syncSearchExample();
}
function renderSearchAccounting(search) {
  const requirements = Array.isArray(search.requirements) ? search.requirements : [];
  const warnings = Array.isArray(search.warnings) ? search.warnings : [];
  // Criteria remain in the user's search text. Surface only actionable accounting.
  $('#search-accounting').innerHTML = search.id ? `<ul class="requirement-list">${requirements.filter(requirement => ['unsatisfied', 'unsupported', 'unmet'].includes(requirement.handling)).map(requirement => `<li><strong>Not met:</strong> ${escapeHTML(requirement.text || requirement.label)}${requirement.reason ? ` · ${escapeHTML(requirement.reason)}` : ''}</li>`).join('')}</ul>${warnings.map(warning => `<p class="model-warning">${escapeHTML(typeof warning === 'string' ? warning : warning.message)}</p>`).join('')}` : '';
}
async function awaitTask(id, valid) {
  if (!id) throw new Error('The service did not identify its background task.');
  for (let attempt = 0; attempt < 16; attempt++) {
    if (!valid()) throw new DOMException('Superseded task', 'AbortError');
    const task = await JustupApi.request(`/tasks/${encodeURIComponent(id)}`);
    if (!valid()) throw new DOMException('Superseded task', 'AbortError');
    if (task.status === 'succeeded' || task.status === 'warning') return task.result;
    if (task.status === 'failed') throw new Error(task.error?.message || 'The background check failed. The accepted search is unchanged.');
    if (!['pending', 'running'].includes(task.status)) throw new Error('The task returned an unknown state.');
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, 700 * (attempt + 1))));
  }
  throw new Error('The check is still pending. Retry the same request to resume it without creating a duplicate.');
}
let searchProposal = null, searchSubmitOwner = null;
function renderSearchProposal(proposal, searchId) {
  searchProposal = { ...proposal, searchId: proposal.searchId || searchId };
  $('#search-status').innerHTML = `<strong>This search needs your decision.</strong><p>${escapeHTML(proposal.message || 'Some requirements cannot be applied.')}</p>${(proposal.requirements || []).filter(item => item.handling === 'unsatisfied').map(item => `<p>${escapeHTML(item.text)}: ${escapeHTML(item.reason || 'not supported')}</p>`).join('')}${(proposal.warnings || []).map(warning => `<p>${escapeHTML(typeof warning === 'string' ? warning : warning.message)}</p>`).join('')}<button class="button outline" id="confirm-search-proposal">Accept these limitations</button>`;
}
async function confirmSearchProposal() {
  const proposal = searchProposal;
  if (!proposal) return;
  const generation = ++searchGeneration;
  proposal.confirmKey ||= JustupApi.key();
  $('#confirm-search-proposal').disabled = true;
  try {
    const result = await JustupApi.request(`/searches/${encodeURIComponent(proposal.searchId)}/confirm`, { method: 'POST', body: { proposalId: proposal.proposalId, expectedRevision: proposal.expectedRevision }, idempotencyKey: proposal.confirmKey });
    const completed = result.task ? await awaitTask(result.task.id, () => generation === searchGeneration) : result;
    if (generation !== searchGeneration) return;
    const accepted = completed.search;
    if (!accepted?.id || accepted.status !== 'ready') throw new Error('The proposal has not become an accepted search.');
    searches = searches.filter(search => search.id !== accepted.id); searches.push(accepted); selectedId = accepted.id; queryDrafts.delete(accepted.id); queryDrafts.delete(null); searchProposal = null;
    renderSearchShell(); $('#search-status').textContent = 'Search saved with your confirmed limitations.'; resetFeed();
  } catch (error) {
    if (generation !== searchGeneration) return;
    if (feedState?.id === selectedId) feedState.generation = searchGeneration;
    $('#search-status').textContent = `${errorText(error)} The last accepted search is unchanged.`;
  }
}
async function saveSearch(options = {}) {
  if (!session) throw new Error('Connect to the service before searching.');
  if (!session.user) { openSignIn('Sign in to interpret and save your search. Your unsent text stays here.'); return; }
  const query = $('#query').value.trim();
  if (!query) { $('#query').focus(); return; }
  searchProposal = null;
  const owner = Symbol('search submission'); searchSubmitOwner = owner;
  const search = current(), generation = ++searchGeneration, previous = search.id;
  const payload = { query, ...(search.id ? { expectedRevision: search.revision } : {}), ...options };
  const fingerprint = JSON.stringify({ id: search.id, payload });
  if (searchMutation?.fingerprint !== fingerprint) searchMutation = { fingerprint, key: JustupApi.key() };
  $('#search-status').textContent = 'Checking every requirement…'; $('#job-search button[type=submit]').disabled = true;
  stopLive();
  try {
    const result = await JustupApi.request(search.id ? `/searches/${encodeURIComponent(search.id)}` : '/searches', { method: search.id ? 'PATCH' : 'POST', body: { ...payload, requestKey: searchMutation.key }, idempotencyKey: searchMutation.key });
    if (generation !== searchGeneration) return;
    const completed = result.task ? await awaitTask(result.task.id, () => generation === searchGeneration) : result;
    if (generation !== searchGeneration) return;
    if (completed.proposal) { renderSearchProposal(completed.proposal, result.search?.id || search.id); if (previous && feedState?.id === previous) feedState.generation = searchGeneration; return; }
    const accepted = completed.search;
    if (!accepted?.id || accepted.revision == null || accepted.status !== 'ready' || typeof accepted.query !== 'string') throw new Error('The service did not return an accepted search revision.');
    searchMutation = null; queryDrafts.delete(accepted.id); if (!previous) queryDrafts.delete(null);
    searches = searches.filter(item => item.id !== accepted.id); searches.push(accepted); selectedId = accepted.id; draft.query = '';
    $('#search-status').textContent = 'Search saved.'; renderSearchShell(); await resetFeed();
  } catch (error) {
    if (generation !== searchGeneration) return;
    $('#search-status').textContent = `${errorText(error)}${previous ? ' The last accepted revision and its results are unchanged.' : ''}`;
    if (previous && feedState?.id === previous) { feedState.generation = searchGeneration; startLive(); }
  } finally { if (searchSubmitOwner === owner) $('#job-search button[type=submit]').disabled = !!session?.user && !capable('search'); }
}
function stopLive() { clearTimeout(liveTimer); liveSource?.close(); liveSource = null; }
function renderAccess(hidden) {
  const count = Number(hidden?.count), hasHidden = Number.isSafeInteger(count) && count > 0;
  $('#access-notice').hidden = !hasHidden;
  $('#access-notice').innerHTML = hasHidden ? `<div class="access-gate-copy"><h2>${hidden.exact === true ? '' : 'At least '}${count} recent matches hidden</h2><p>${escapeHTML(session?.access?.description || 'Your current access does not include the latest matches.')}</p>${!session?.user ? '<button class="button dark" data-sign-in>Sign in ↗</button>' : ''}</div>` : '';
  // Decorative compression uses empty shapes, never restricted job DTOs.
  if (hasHidden) $('#access-notice').insertAdjacentHTML('afterbegin', '<div class="compressed-edition" aria-hidden="true"><i></i><i></i><i></i></div>');
}
async function resetFeed() {
  stopLive();
  const search = current();
  if (!search.id) return;
  const generation = ++searchGeneration;
  feedState = { generation, id: search.id, revision: search.revision, cursor: null, seenCursors: new Set(), ids: new Set(), buffer: [], loading: false, scanState: 'ready', error: null, initial: true, revealing: false };
  $('#feed').replaceChildren(); $('#search-results').hidden = false; $('#access-notice').hidden = true;
  await fetchResults(feedState);
  if (feedState?.generation === generation) startLive();
}
function validFeed(state) { return state === feedState && state.generation === searchGeneration && state.id === selectedId && state.revision === current().revision; }
async function fetchResults(state) {
  if (!validFeed(state) || state.loading || state.scanState === 'complete') return;
  state.loading = true; state.error = null; renderFeedStatus();
  try {
    const query = new URLSearchParams({ revision: String(state.revision) }); if (state.cursor) query.set('cursor', state.cursor);
    const response = await JustupApi.request(`/searches/${encodeURIComponent(state.id)}/results?${query}`);
    if (!validFeed(state)) return;
    if (response.revision !== state.revision || !Array.isArray(response.items) || !['open', 'pending', 'paused', 'exhausted', 'failed'].includes(response.continuation?.state)) throw new Error('The service returned results for an unexpected search revision. Refresh this search to continue.');
    // The endpoint must send only authorized confirmed matches. Do not hide received DTOs with CSS.
    for (const job of response.items) {
      if (!job.id || !sourceURL(job.sourceUrl) || !job.title || !job.company?.id || !job.company?.name || !Number.isFinite(new Date(job.firstObserved).getTime())) throw new Error('The service returned an invalid posting. No unverified source link was displayed.');
      if (state.ids.has(job.id)) continue;
      state.ids.add(job.id); state.buffer.push(job);
    }
    const next = response.continuation.cursor || null;
    if (next && next === state.cursor && response.continuation?.state !== 'exhausted') throw new Error('The search stopped making progress. Retry or refresh the search.');
    if (next && state.seenCursors.has(next)) throw new Error('The service repeated a results cursor. Refresh this search.');
    if (next) state.seenCursors.add(next);
    state.cursor = next; state.scanState = ({ open: 'ready', pending: 'scanning', paused: 'paused', exhausted: 'complete', failed: 'failed' })[response.continuation.state]; state.retryAfterMs = response.continuation.retryAfterMs; state.ai = response.ai || {}; state.hidden = response.hidden; renderAccess(capable('hiddenMatchCounts') ? response.hidden : null);
    // Fill only the first viewport; all further rows are gated by the viewport sentinel.
    if (state.initial) { state.initial = false; fillVisibleSlots(state.buffer, '#feed-tail', job => appendJob(job, false)); }
  } catch (error) { if (validFeed(state)) state.error = error; }
  finally { if (validFeed(state)) { state.loading = false; renderFeedStatus(); maybeAdvance(); } }
}
function salaryText(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const validAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const min = validAmount(salary.min) ? salary.min : null, max = validAmount(salary.max) ? salary.max : null;
  if (min === null && max === null) return '';
  const format = value => new Intl.NumberFormat('en', { maximumFractionDigits: 20 }).format(value);
  const amount = min !== null && max !== null ? min === max ? format(min) : `${format(min)}–${format(max)}` : format(min ?? max);
  const currency = typeof salary.currency === 'string' ? salary.currency.trim() : '';
  const period = typeof salary.period === 'string' ? salary.period.trim() : '';
  const bound = min === null ? 'Up to ' : max === null ? 'From ' : '';
  return `${bound}${currency ? currency + ' ' : ''}${amount}${period ? ' / ' + period : ''}`;
}
function appendJob(job, animated) {
  const company = job.company, pay = salaryText(job.salary);
  const facts = [job.locations?.map(location => location.name).filter(Boolean).join(', '), [...new Set((job.locations || []).map(location => location.workplace).filter(Boolean))].join(', '), job.employmentTypes?.map(value => value.replaceAll('_', ' ')).join(', ')].filter(Boolean).map((value, index) => `<span>${index === 0 ? '<span aria-hidden="true">⌖ </span>' : ''}${escapeHTML(value)}</span>`).join('');
  const slot = document.createElement('div'); slot.className = 'job-slot';
  slot.innerHTML = `<article class="job list-row clickable-row${job.viewed ? ' viewed' : ''}${job.isNew ? ' is-new' : ''}" data-job="${escapeHTML(job.id)}"><div class="job-age">${job.isNew ? '<span class="new-badge">New</span>' : ''}<time datetime="${escapeHTML(job.firstObserved)}" title="First observed ${escapeHTML(dateText(job.firstObserved))}">${ageText(job.firstObserved)}</time></div><div class="job-story"><h2 class="job-title"><a class="posting-link row-link" href="${escapeHTML(sourceURL(job.sourceUrl))}" target="_blank" rel="noopener noreferrer">${escapeHTML(job.title)}</a></h2><div class="job-facts">${facts}</div>${pay ? `<span class="job-salary"><span aria-hidden="true">¤ </span>${escapeHTML(pay)}</span>` : ''}</div><div class="job-employer"><a class="job-company" href="#company/${encodeURIComponent(company.id)}">${companyMark(company)}<span>${escapeHTML(company.name)}</span></a><p class="job-source">Direct from employer</p></div><span class="open-posting" aria-hidden="true">↗</span></article>`;
  const row = slot.firstElementChild;
  row.addEventListener('click', event => {
    if (event.target.closest('.job-company')) return;
    if (!event.target.closest('a')) row.querySelector('.posting-link').click();
  });
  row.querySelector('.posting-link').addEventListener('click', () => {
    if (!capable('viewed')) return;
    const generation = sessionGeneration;
    JustupApi.request(`/me/viewed/${encodeURIComponent(job.id)}`, { method: 'PUT' }).then(() => { if (generation === sessionGeneration && row.isConnected) row.classList.add('viewed'); }).catch(error => announce(`Viewed state was not saved. ${errorText(error)}`));
  });
  $('#feed').append(slot);
  if (animated && !reduced()) row.animate([{ opacity: .2, clipPath: 'inset(0 0 85% 0)' }, { opacity: 1, clipPath: 'inset(0)' }], { duration: 450, easing: 'cubic-bezier(.2,.7,.25,1)' });
}
function fillVisibleSlots(buffer, tail, append) {
  // Measure again after every actual row: wrapping and mobile layout change its height.
  while (buffer.length && !document.hidden && tailVisible(tail)) append(buffer.shift());
}
function tailVisible(selector) { const rectangle = $(selector).getBoundingClientRect(); return rectangle.top < innerHeight && rectangle.bottom > 0; }
function maybeAdvance() {
  const state = feedState;
  if (!state || !validFeed(state) || state.revealing || document.hidden || $('#jobs-page').hidden || !tailVisible('#feed-tail') || state.error || state.loading) return;
  if (state.buffer.length) {
    state.revealing = true;
    // Recheck at completion: scrolling away must never reveal unseen rows offscreen.
    setTimeout(() => { if (!validFeed(state)) return; state.revealing = false; if (!tailVisible('#feed-tail') || $('#jobs-page').hidden) return; appendJob(state.buffer.shift(), true); renderFeedStatus(); maybeAdvance(); }, 450);
  } else if (state.scanState !== 'complete' && state.scanState !== 'paused' && state.scanState !== 'failed' && state.cursor) {
    state.revealing = true; setTimeout(() => { if (!validFeed(state)) return; state.revealing = false; if (tailVisible('#feed-tail')) fetchResults(state); }, Math.max(450, Math.min(30000, Number(state.retryAfterMs) || 0)));
  }
}
function renderFeedStatus() {
  const state = feedState; if (!state) return;
  let text;
  if (state.error) text = `${escapeHTML(errorText(state.error))} <button class="text-link" id="retry-results">Retry</button>`;
  else if (state.loading || state.buffer.length || state.scanState === 'scanning') text = '<span class="looking"><span class="looking-mark" aria-hidden="true"><i></i><i></i><i></i></span>Still checking for matching positions…</span>';
  else if (state.scanState === 'failed') text = 'Requirement checks failed. Matches have not been substituted. <button class="text-link" id="resume-results">Try again</button>';
  else if (state.scanState === 'paused') text = 'Search paused. There may be more matches. <button class="text-link" id="resume-results">Check again</button>';
  else if (state.scanState === 'complete') text = state.ids.size ? 'You’ve reached the back page of available matches.' : state.ai?.pending || state.ai?.failed || state.ai?.insufficientEvidence || ['pending', 'failed', 'insufficient_evidence'].includes(state.ai?.status) ? 'No confirmed matches. Some positions could not yet be evaluated.' : 'No matching positions found in the completed search.';
  else text = 'More results are not available yet. <button class="text-link" id="resume-results">Check again</button>';
  const ai = state.ai || {};
  if (ai.pending) text += `<span class="end-note">${escapeHTML(ai.pending)} positions still awaiting requirement checks.</span>`;
  if (ai.failed) text += `<span class="end-note">${escapeHTML(ai.failed)} checks failed. These positions are not included.</span>`;
  if (ai.insufficientEvidence) text += `<span class="end-note">${escapeHTML(ai.insufficientEvidence)} positions lack enough evidence to confirm a match.</span>`;
  $('#feed-status').innerHTML = text;
}
function startLive() {
  stopLive(); const state = feedState;
  if (!state || !validFeed(state)) return;
  // Polling is a bounded fallback until the event capability is supplied by the backend.
  if (!capable('polling')) { $('#live-status').textContent = 'Live updates unavailable · refresh to check'; return; }
  $('#live-status').textContent = 'Checking for updates every 30 seconds';
  liveTimer = setTimeout(async () => {
    if (!validFeed(state)) return;
    if (document.hidden || $('#jobs-page').hidden) { startLive(); return; }
    try {
      const response = await JustupApi.request(`/searches/${encodeURIComponent(state.id)}/results?revision=${encodeURIComponent(state.revision)}`);
      if (!validFeed(state) || response.revision !== state.revision) return;
      const arrivals = (response.items || []).filter(job => !state.ids.has(job.id));
      // Keep the reading position stable; user explicitly reveals arrivals above their reading point.
      if (arrivals.length) { $('#live-status').innerHTML = '<button class="text-link" id="refresh-results">New matches available ↑</button>'; return; }
      startLive();
    } catch { if (validFeed(state)) $('#live-status').innerHTML = 'Live updates unavailable. <button class="text-link" id="refresh-results">Refresh</button>'; }
  }, 30000);
}
async function loadCompanies(reset = true) {
  if (!session) { $('#company-scroll-status').textContent = 'The company catalogue is unavailable until the service reconnects.'; return; }
  if (reset) { catalogueGeneration++; catalogueState = { generation: catalogueGeneration, cursor: null, buffer: [], ids: new Set(), loading: false, complete: false, error: null, revealing: false }; $('#company-list').replaceChildren(); }
  const state = catalogueState;
  if (!state || state.loading || state.complete) return;
  state.loading = true; state.error = null; $('#company-scroll-status').textContent = 'Checking the directory…';
  const query = new URLSearchParams({ q: $('#company-query').value.trim() }); if (state.cursor) query.set('cursor', state.cursor);
  try {
    const result = await JustupApi.request('/companies?' + query);
    if (state !== catalogueState) return;
    if (!Array.isArray(result.items)) throw new Error('The catalogue returned an unreadable response.');
    for (const company of result.items) if (company.id && !state.ids.has(company.id)) { state.ids.add(company.id); state.buffer.push(company); }
    if (result.nextCursor && result.nextCursor === state.cursor) throw new Error('The catalogue did not advance. Please refresh.');
    state.cursor = result.nextCursor || null; state.complete = !state.cursor;
    if (reset) fillVisibleSlots(state.buffer, '#company-tail', appendCompany);
  } catch (error) { if (state === catalogueState) state.error = error; }
  finally { if (state === catalogueState) { state.loading = false; renderCatalogueStatus(); advanceCatalogue(); } }
}
function appendCompany(company) {
  const row = document.createElement('article'); row.className = 'company-row list-row clickable-row'; row.dataset.company = company.id;
  row.innerHTML = `<div class="company-info"><a class="company-name row-link" href="#company/${encodeURIComponent(company.id)}">${companyMark(company)}<span>${escapeHTML(company.name)}</span></a></div><div class="company-industry">${escapeHTML(company.industry || company.description || '')}</div><div class="company-state"><span class="status">${escapeHTML(coverageLabel(company.coverage?.state))}</span></div><div class="company-actions">${capable('follows') ? `<button class="follow-company" data-follow="${escapeHTML(company.id)}" aria-pressed="${company.followed === true}">${company.followed ? 'Following ✓' : 'Follow +'}</button>` : ''}<span class="company-open" aria-hidden="true">↗</span></div>`;
  row.addEventListener('click', event => { if (!event.target.closest('a,button')) row.querySelector('a').click(); });
  $('#company-list').append(row);
}
function renderCatalogueStatus() {
  const state = catalogueState; if (!state) return;
  $('#company-scroll-status').innerHTML = state.error ? `${escapeHTML(errorText(state.error))} <button id="retry-companies" class="text-link">Retry</button>` : state.buffer.length || state.loading ? 'More from the directory…' : state.complete ? `${state.ids.size ? 'That’s the directory so far.' : 'No companies found.'} <a class="text-link" href="#request">Send us a lead ↗</a>` : 'Scroll for more companies.';
}
function advanceCatalogue() {
  const state = catalogueState;
  if (!state || state.loading || state.revealing || state.error || $('#companies-page').hidden || !tailVisible('#company-tail') || document.hidden) return;
  if (!state.buffer.length) { if (!state.complete) loadCompanies(false); return; }
  state.revealing = true;
  setTimeout(() => { if (state !== catalogueState) return; state.revealing = false; if ($('#companies-page').hidden || !tailVisible('#company-tail')) return; appendCompany(state.buffer.shift()); renderCatalogueStatus(); advanceCatalogue(); }, 450);
}
async function followCompany(id, button) {
  if (!capable('follows')) { openSignIn('Sign in to follow companies.'); return; }
  const generation = sessionGeneration;
  const following = button.getAttribute('aria-pressed') === 'true'; button.disabled = true;
  try { await JustupApi.request(`/me/follows/${encodeURIComponent(id)}`, { method: following ? 'DELETE' : 'PUT' }); if (generation === sessionGeneration && button.isConnected) { button.setAttribute('aria-pressed', String(!following)); button.textContent = following ? 'Follow +' : 'Following ✓'; } }
  catch (error) { announce(errorText(error)); }
  finally { button.disabled = false; }
}
async function loadCompany(id) {
  const generation = ++companyGeneration; $('#company-page').textContent = 'Opening the company report…';
  try { const company = await JustupApi.request(`/companies/${encodeURIComponent(id)}`); if (generation === companyGeneration) renderCompanyReport(company.company || company); }
  catch (error) { if (generation === companyGeneration) $('#company-page').innerHTML = `<a class="back" href="#jobs">← Back to search</a><h1>Report unavailable.</h1><p>${escapeHTML(errorText(error))}</p><button class="button outline" id="retry-company">Try again</button>`; }
}
function renderRequestForm() {
  clearTimeout(requestTimer); requestGeneration++; requestState = null; requestPolls = 0;
  $('#request-content').innerHTML = `<form id="request-form" class="request-form"><label for="request-query">Company name or website</label><div class="query-field"><input id="request-query" type="text" required autocomplete="organization" placeholder="A name. We’ll check the facts."></div><p class="helper">Give us a lead. You’ll confirm the company before it joins the catalogue.</p><button class="button dark" type="submit">Find company ↗</button></form><p id="request-status" role="status"></p>`;
  $('#step-find').classList.add('active'); $('#step-confirm').classList.remove('active'); $('#step-add').classList.remove('active');
  if (!session?.user || !capable('companyRequests')) { $('#request-form button').disabled = !!session?.user; $('#request-status').textContent = session?.user ? 'Company requests are not available in this demo yet.' : 'Sign in to request a company.'; if (!session?.user) $('#request-status').insertAdjacentHTML('beforeend', ' <button class="text-link" data-sign-in>Sign in</button>'); }
}
async function discoverCompany(query, clarification) {
  if (!session?.user) { openSignIn('Sign in to request a company. Your company lead and search draft stay here.'); return; }
  if (!capable('companyRequests')) throw new Error('Company requests are unavailable right now.');
  const previous = requestState, generation = ++requestGeneration, accountGeneration = sessionGeneration;
  $('#request-status').textContent = 'Following your lead…';
  const payload = { input: clarification ? `${query} — ${clarification}` : query };
  const fingerprint = JSON.stringify(payload);
  if (discoveryMutation?.fingerprint !== fingerprint) discoveryMutation = { fingerprint, key: JustupApi.key() };
  const mutation = discoveryMutation;
  try {
  const response = mutation.response || await JustupApi.request('/company-requests', { method: 'POST', body: { ...payload, requestKey: mutation.key }, idempotencyKey: mutation.key });
  if (generation !== requestGeneration || accountGeneration !== sessionGeneration || $('#request-page').hidden) return;
  mutation.response = response; requestPolls = 0;
  const completed = response.task ? await awaitTask(response.task.id, () => generation === requestGeneration && accountGeneration === sessionGeneration && !$('#request-page').hidden) : response;
  if (generation !== requestGeneration || accountGeneration !== sessionGeneration || $('#request-page').hidden) return;
  discoveryMutation = null;
  requestState = completed.request; renderCompanyRequest();
  } catch (error) { if (generation === requestGeneration && accountGeneration === sessionGeneration) throw error; }
}
function renderCompanyRequest() {
  const request = requestState; if (!request) return;
  clearTimeout(requestTimer);
  $('#step-find').classList.toggle('active', ['pending', 'clarification', 'unresolved'].includes(request.status)); $('#step-confirm').classList.toggle('active', request.status === 'candidate'); $('#step-add').classList.toggle('active', request.status === 'accepted');
  const status = '<p id="request-status" role="status"></p>';
  if (request.status === 'pending') {
    $('#request-content').innerHTML = `<h2>Checking the lead.</h2><p>We’re looking for the right company. No company has been added yet.</p><button id="refresh-request" class="button outline">Check again</button>${status}`;
    if (requestPolls++ < 15) requestTimer = setTimeout(() => runAction(refreshRequest, $('#request-status')), 4000);
  } else if (request.status === 'candidate') {
    const candidate = request.candidate || {};
    requestState.acceptKey ||= JustupApi.key();
    $('#request-content').innerHTML = `<div class="candidate"><span class="eyebrow">Company found · please confirm</span><div class="candidate-heading">${companyMark(candidate)}<h2>${escapeHTML(candidate.name)}</h2></div>${candidate.description ? `<p>${escapeHTML(candidate.description)}</p>` : ''}${candidate.websiteUrl && sourceURL(candidate.websiteUrl) ? `<a class="text-link" href="${escapeHTML(sourceURL(candidate.websiteUrl))}" target="_blank" rel="noopener noreferrer">Check company website ↗</a>` : ''}<p>${escapeHTML(coverageLabel(candidate.coverage?.state))}</p>${(candidate.evidenceUrls || []).filter(sourceURL).length ? `<p class="small-print">Sources: ${(candidate.evidenceUrls || []).filter(sourceURL).map(url => `<a href="${escapeHTML(sourceURL(url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(new URL(url).hostname)} ↗</a>`).join(' · ')}</p>` : ''}</div><div class="candidate-actions"><button class="button dark" id="accept-company" ${!candidate.id || request.previewRevision == null ? 'disabled' : ''}>Yes, that’s the one ↗</button><button class="text-link" id="reject-company">Not this company</button></div>${status}`;
  } else if (request.status === 'clarification') {
    $('#request-content').innerHTML = `<h2>A little more to go on.</h2><p>${escapeHTML(request.clarification || 'Which company did you mean?')}</p><form id="clarification-form"><label for="company-clarification">More details</label><div class="query-field"><input id="company-clarification" required placeholder="Website, industry, or the full name"></div><button class="button dark">Continue ↗</button></form>${status}`;
  } else if (request.status === 'unresolved') {
    $('#request-content').innerHTML = `<h2>No confirmed match.</h2><p>${escapeHTML(request.reason || 'We couldn’t confidently identify this company. Try its website or full name.')}</p><button class="button outline" id="new-request">Try another lead</button>${status}`;
  } else if (request.status === 'accepted') {
    $('#request-content').innerHTML = `<h2>On the record.</h2><p>${escapeHTML(request.message || 'The company identity request is recorded. This does not start career-page setup.')}</p>${request.company?.id ? `<a class="button dark" href="#company/${encodeURIComponent(request.company.id)}">View company ↗</a>` : '<a class="button outline" href="#companies">Company catalogue ↗</a>'}${status}`;
  } else $('#request-content').innerHTML = `<h2>Request unavailable.</h2><p>The service returned an unknown request state.</p><button class="button outline" id="new-request">Start again</button>${status}`;
}
async function refreshRequest() {
  if (!requestState?.id || $('#request-page').hidden) return;
  // The collection endpoint also supports resuming accepted server-owned request IDs.
  const id = requestState.id, generation = requestGeneration, accountGeneration = sessionGeneration;
  const result = await JustupApi.request('/company-requests');
  if (generation !== requestGeneration || accountGeneration !== sessionGeneration || requestState?.id !== id || $('#request-page').hidden) return;
  const updated = result.items?.find(item => item.id === id);
  if (!updated) throw new Error('This request is no longer available.');
  requestState = updated; renderCompanyRequest();
}
async function acceptCompany() {
  const request = requestState, candidate = request?.candidate, generation = requestGeneration, accountGeneration = sessionGeneration; if (!candidate) return;
  $('#accept-company').disabled = true;
  try {
    const result = await JustupApi.request(`/company-requests/${encodeURIComponent(request.id)}/accept`, { method: 'POST', body: { candidateId: candidate.id, previewRevision: request.previewRevision }, idempotencyKey: request.acceptKey });
    if (generation !== requestGeneration || accountGeneration !== sessionGeneration || requestState !== request || $('#request-page').hidden) return;
    requestState = result.request; renderCompanyRequest();
  } finally { if ($('#accept-company')) $('#accept-company').disabled = false; }
}
async function savePostingLanguages(selection) {
  if (!capable('preferences')) throw new Error('Posting-language preferences are unavailable in this demo.');
  const result = await JustupApi.request('/me/preferences', { method: 'PATCH', body: { postingLanguages: [...selection] } });
  postingLanguages = new Set(result.postingLanguages || result.preferences?.postingLanguages || []); renderPostingLanguageControls();
  if (selectedId) await saveSearch();
}
function route() {
  const [page = 'jobs', encodedId] = location.hash.slice(1).split('/');
  const active = ['jobs', 'companies', 'company', 'request'].includes(page) ? page : 'jobs';
  for (const name of ['jobs', 'companies', 'company', 'request']) $(`#${name}-page`).hidden = name !== active;
  $$('[data-nav]').forEach(link => { if (link.dataset.nav === active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  if (active === 'jobs' && selectedId && (!feedState || feedState.id !== selectedId)) resetFeed();
  if (active === 'companies' && !catalogueState) loadCompanies();
  if (active === 'company' && encodedId) { try { loadCompany(decodeURIComponent(encodedId)); } catch { $('#company-page').textContent = 'Invalid company link.'; } }
  if (active === 'request' && !requestState) renderRequestForm();
  if (active !== 'request') clearTimeout(requestTimer);
  syncSearchExample(); maybeAdvance(); advanceCatalogue();
}
function init() {
  // Remove the obsolete prototype cache without reading, migrating or uploading its contents.
  try { localStorage.removeItem('justup-prototype-v1'); } catch {}
  $('#edition-date').textContent = new Date().toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'long' });
  initSurfaces(); initPostingLanguages(); initSearchExamples();
  $('#job-search').addEventListener('submit', event => { event.preventDefault(); runAction(saveSearch); });
  $('#query').addEventListener('input', () => { if (searchProposal) { searchProposal = null; $('#search-status').textContent = 'Search text changed. Submit it to check the updated request.'; } queryDrafts.set(selectedId, $('#query').value); if (!selectedId) draft.query = $('#query').value; });
  $('#company-search').addEventListener('submit', event => { event.preventDefault(); loadCompanies(); });
  $('#followed-only').addEventListener('click', () => { followedOnly = !followedOnly; $('#followed-only').setAttribute('aria-pressed', String(followedOnly)); if (selectedId) runAction(saveSearch); });
  $('#add-search').addEventListener('click', () => { searchGeneration++; stopLive(); selectedId = null; feedState = null; draft.query = ''; queryDrafts.delete(null); renderSearchShell(); location.hash = 'jobs'; $('#query').focus(); });
  document.addEventListener('click', event => {
    const search = event.target.closest('[data-search]'); if (search) { selectedId = search.dataset.search; renderSearchShell(); location.hash = 'jobs'; resetFeed(); }
    const deletion = event.target.closest('[data-delete-search]'); if (deletion) { pendingDeleteId = deletion.dataset.deleteSearch; $('#delete-search-description').textContent = 'This saved search will be deleted from your account.'; $('#delete-search-dialog').showModal(); }
    const follow = event.target.closest('[data-follow]'); if (follow) followCompany(follow.dataset.follow, follow);
    const status = event.target.closest('[data-status]'); if (status) { companyFilter = status.dataset.status; $$('[data-status]').forEach(button => button.setAttribute('aria-pressed', String(button === status))); loadCompanies(); }
    if (event.target.closest('#retry-session')) bootstrap();
    if (event.target.closest('#confirm-search-proposal')) runAction(confirmSearchProposal);
    if (event.target.closest('#retry-results,#resume-results')) { if (feedState) { feedState.error = null; if (['paused', 'failed'].includes(feedState.scanState)) feedState.scanState = 'ready'; fetchResults(feedState); } }
    if (event.target.closest('#refresh-results')) resetFeed();
    if (event.target.closest('#retry-companies')) loadCompanies(false);
    if (event.target.closest('#retry-company')) route();
    if (event.target.closest('#new-request')) renderRequestForm();
    if (event.target.closest('#refresh-request')) runAction(refreshRequest, $('#request-status'));
    if (event.target.closest('#accept-company')) runAction(acceptCompany, $('#request-status'));
    if (event.target.closest('#reject-company')) runAction(async () => { await JustupApi.request(`/company-requests/${encodeURIComponent(requestState.id)}`, { method: 'DELETE', idempotencyKey: JustupApi.key() }); renderRequestForm(); }, $('#request-status'));
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'request-form') { event.preventDefault(); runAction(() => discoverCompany($('#request-query').value.trim()), $('#request-status')); }
    if (event.target.id === 'clarification-form') { event.preventDefault(); runAction(() => discoverCompany(requestState.input, $('#company-clarification').value.trim()), $('#request-status')); }
  });
  $('#confirm-delete-search').addEventListener('click', () => runAction(async () => {
    const id = pendingDeleteId;
    await JustupApi.request(`/searches/${encodeURIComponent(id)}`, { method: 'DELETE', idempotencyKey: JustupApi.key() });
    searches = searches.filter(search => search.id !== id); queryDrafts.delete(id); $('#delete-search-dialog').close();
    const deletedActive = selectedId === id;
    if (deletedActive) { selectedId = searches[0]?.id || null; searchGeneration++; stopLive(); feedState = null; $('#feed').replaceChildren(); }
    renderSearchShell(); if (deletedActive && selectedId) resetFeed(); else if (!selectedId) { $('#query').value = ''; $('#query').focus(); }
  }, $('#delete-search-description')));
  const onScroll = () => { $('#back-to-top').hidden = scrollY < 500; maybeAdvance(); advanceCatalogue(); };
  window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll); document.addEventListener('visibilitychange', onScroll);
  $('#back-to-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduced() ? 'instant' : 'smooth' }));
  window.addEventListener('hashchange', route);
  window.addEventListener('justup-session-expired', () => { sessionGeneration++; clearProtectedState(); $('#search-status').textContent = 'Your session expired. Please sign in again.'; $('#header-sign-in').hidden = false; $('#service-notice').hidden = false; $('#service-notice').innerHTML = '<p>Your session expired.</p><button id="retry-session" class="button outline">Reconnect</button>'; renderSearchShell(); $('#job-search button[type=submit]').disabled = true; openSignIn('Your session expired. Refresh to reconnect before signing in.'); });
  bootstrap();
}
init();
