// A request records a supported identity, never an invented company or crawler start.
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import type { CompanyRequestPrefill, Session } from '../../api/types';
import { CompanyMark } from '../../shared/CompanyMark';
import { coverageLabel, safeSourceUrl } from './presentation';
import { useCompanyRequest } from './useCompanyRequest';

export interface CompanyRequestPageProps {
  client: ApiClient;
  session: Session | null;
  active: boolean;
  onSignIn: (reason?: string) => void;
  accountEpoch: number;
  prefill: CompanyRequestPrefill | null;
  onPrefillConsumed: () => void;
}
export function CompanyRequestPage({ client, session, active, onSignIn, accountEpoch, prefill, onPrefillConsumed }: CompanyRequestPageProps) {
  const [input, setInput] = useState('');
  const [scope, setScope] = useState('');
  const [clarification, setClarification] = useState('');
  const previousUser = useRef(session?.user?.id ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusPrefill = useRef(false);
  const flow = useCompanyRequest(client, active, accountEpoch);
  useLayoutEffect(() => {
    if (!prefill) return;
    focusPrefill.current = true;
    flow.reset();
    setInput(prefill.input);
    setScope(prefill.scope ?? '');
    setClarification('');
    onPrefillConsumed();
  }, [prefill, onPrefillConsumed, flow.reset]);
  useLayoutEffect(() => {
    if (focusPrefill.current && active && !flow.request && !flow.busy && inputRef.current) {
      focusPrefill.current = false;
      inputRef.current.focus();
    }
  }, [active, flow.request, flow.busy, prefill]);
  useLayoutEffect(() => {
    const user = session?.user?.id ?? null;
    if (previousUser.current && previousUser.current !== user) { setInput(''); setScope(''); setClarification(''); }
    previousUser.current = user;
  }, [session?.user?.id, accountEpoch]);
  const request = flow.request;
  const canSubmit = !session?.user || session.capabilities.companyRequests === true;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.user) { onSignIn('Sign in to request a company. Your lead stays here.'); return; }
    if (canSubmit && !flow.busy) void flow.resolveLookup(input.trim(), scope.trim() || null);
  }
  function submitClarification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !clarification.trim() || flow.busy) return;
    const next = `${request.input} — ${clarification.trim()}`; setClarification(''); void flow.resolveLookup(next, scope.trim() || null);
  }
  const stage = request?.status === 'accepted' ? 'recorded' : request?.status === 'candidate' ? 'confirm' : 'find';
  const candidate = request?.candidate;
  const website = safeSourceUrl(candidate?.websiteUrl);
  const evidence = [...new Set(candidate?.evidenceUrls?.flatMap(value => { const url = safeSourceUrl(value); return url ? [url] : []; }) || [])];
  return <section id="request-page" className="page" hidden={!active}>
    <a className="back" href="#companies">← Company catalogue</a>
    <div className="section-heading"><h1>WANTED</h1><span className="eyebrow">Request a company</span></div>
    <div className="request-layout">
      <aside><p className="request-lead">Your next role could be<br />at a company we don’t<br />know about. Yet.</p>
        <ol className="request-steps"><li id="step-find" className={stage === 'find' ? 'active' : ''}><span>01</span> Send us a lead</li><li id="step-confirm" className={stage === 'confirm' ? 'active' : ''}><span>02</span> Confirm it’s the one</li><li id="step-add" className={stage === 'recorded' ? 'active' : ''}><span>03</span> Request recorded</li></ol>
        <p className="request-note">Help grow the edition.<br />One good lead at a time.</p>
      </aside>
      <div id="request-content" aria-busy={flow.busy}>
        {!request ? <>
          <form id="request-form" className="request-form" onSubmit={submit}>
            <label htmlFor="request-query">Company name or website</label><div className="query-field"><input ref={inputRef} id="request-query" type="text" required disabled={flow.busy} maxLength={500} autoComplete="organization" placeholder="A name. We’ll check the facts." value={input} onChange={event => setInput(event.target.value)} /></div>
            <label htmlFor="request-scope">What to include <span className="small-print">(optional)</span></label>
            <div className="query-field">
              <input id="request-scope" type="text" disabled={flow.busy} maxLength={500}
                value={scope} onChange={event => setScope(event.target.value)}
                placeholder="A particular division or career page" />
            </div>
            <p className="helper">Give us a lead. You’ll confirm the company before it joins the catalogue.</p>
            <button className="button dark" type="submit" disabled={flow.busy || !canSubmit}>Find company ↗</button>
          </form>
          {!canSubmit ? <p className="helper">Company requests are not available in this demo yet.</p> : null}
        </> : request.status === 'pending' ? <>
          <h2>Checking the lead.</h2><p>We’re looking for the right company. No company has been added yet.</p>
          <button id="refresh-request" className="button outline" disabled={flow.busy} onClick={() => void flow.refresh()}>Check again</button>
          {flow.busy ? <span className="request-progress" role="status">Following your lead…</span> : null}
        </> : request.status === 'candidate' && candidate ? <>
          <div className="candidate"><span className="eyebrow">Company found · please confirm</span><div className="candidate-heading"><CompanyMark company={candidate} /><h2>{candidate.name}</h2></div>
            {candidate.description ? <p>{candidate.description}</p> : null}
            {website ? <a className="text-link" href={website} target="_blank" rel="noopener noreferrer">Check company website ↗</a> : null}
            <p>{coverageLabel(candidate.coverage?.state)}</p>
            {evidence.length ? <p className="small-print">Sources: {evidence.map((url, index) => <span key={url}>{index > 0 ? ' · ' : ''}<a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname} ↗</a></span>)}</p> : null}
          </div>
          <div className="candidate-actions"><button className="button dark" id="accept-company" disabled={flow.busy || request.previewRevision === null} onClick={() => void flow.accept()}>Yes, that’s the one ↗</button><button className="text-link" id="reject-company" disabled={flow.busy} onClick={() => void flow.reject()}>Not this company</button></div>
        </> : request.status === 'clarification' ? <>
          <h2>A little more to go on.</h2><p>{request.clarification || 'Which company did you mean?'}</p>
          <form id="clarification-form" onSubmit={submitClarification}><label htmlFor="company-clarification">More details</label><div className="query-field"><input id="company-clarification" required disabled={flow.busy} maxLength={500} placeholder="Website, industry, or the full name" value={clarification} onChange={event => setClarification(event.target.value)} /></div><button className="button dark" disabled={flow.busy}>Continue ↗</button></form>
        </> : request.status === 'unresolved' ? <>
          <h2>No confirmed match.</h2><p>{request.reason || 'We couldn’t confidently identify this company. Try its website or full name.'}</p><button className="button outline" id="new-request" onClick={flow.reset}>Try another lead</button>
        </> : request.status === 'accepted' ? <>
          <h2>On the record.</h2><p>{request.message || 'The company identity request is recorded. This does not start career-page setup.'}</p>
          {request.company?.id ? <a className="button dark" href={`#company/${encodeURIComponent(request.company.id)}`}>View company ↗</a> : <a className="button outline" href="#companies">Company catalogue ↗</a>}
        </> : <><h2>Request unavailable.</h2><p>The service returned an unknown request state.</p><button className="button outline" onClick={flow.reset}>Start again</button></>}
        <p id="request-status" role="status">{flow.error || (!request && flow.busy ? 'Following your lead…' : '')}</p>
        {flow.error && request?.status === 'pending' ? <button className="text-link" disabled={flow.busy} onClick={flow.reset}>Try another lead</button> : null}
      </div>
    </div>
  </section>;
}
