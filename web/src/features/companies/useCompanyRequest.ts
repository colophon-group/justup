// Keep task identity and idempotency together so a pending lookup can resume safely.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client';
import { pollTask, TaskFailure } from '../../api/tasks';
import type { CompanyRequest, RequestSubmission } from '../../api/types';

interface PendingLookup { input: string; scope: string | null; key: string; submission?: RequestSubmission }
export function useCompanyRequest(client: ApiClient, active: boolean, accountEpoch: number) {
  const [request, setRequest] = useState<CompanyRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<PendingLookup | null>(null);
  const acceptance = useRef<{ requestId: string; preview: number; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    generation.current++; controller.current?.abort(); pending.current = null; acceptance.current = null;
    setRequest(null); setError(''); setBusy(false);
  }, [accountEpoch]);
  useEffect(() => { if (!active) { generation.current++; controller.current?.abort(); setBusy(false); } }, [active]);
  function begin() {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const id = ++generation.current; setBusy(true); setError('');
    return { abort, valid: () => mounted.current && id === generation.current && !abort.signal.aborted };
  }
  async function resolveLookup(input: string, scope: string | null = null) {
    if (!input.trim()) return;
    const operation = begin();
    if (pending.current?.input !== input || pending.current.scope !== scope)
      pending.current = { input, scope, key: crypto.randomUUID() };
    const lookup = pending.current;
    try {
      const submission = lookup.submission ?? await client.createCompanyRequest({ input, ...(scope === null ? {} : { scope }), requestKey: lookup.key }, operation.abort.signal);
      if (!operation.valid()) return;
      lookup.submission = submission; setRequest(submission.request);
      if (!submission.task) { pending.current = null; return; }
      const result = await pollTask(client, submission.task.id, operation.abort.signal);
      if (!operation.valid()) return;
      if (!('request' in result)) throw new Error('The company check returned an unexpected result. Please try another lead.');
      setRequest(result.request); pending.current = null;
    } catch (failure) {
      if (!operation.valid() || isAbortError(failure)) return;
      if (failure instanceof TaskFailure) pending.current = null;
      setError(errorText(failure));
    } finally { if (operation.valid()) setBusy(false); }
  }
  async function refresh() {
    if (pending.current) { await resolveLookup(pending.current.input, pending.current.scope); return; }
    if (!request) return;
    const current = request, operation = begin();
    try {
      const items = await client.listCompanyRequests(operation.abort.signal);
      if (!operation.valid()) return;
      const updated = items.find(item => item.id === current.id);
      if (!updated) throw new Error('This request is no longer available.');
      setRequest(updated);
    } catch (failure) { if (operation.valid() && !isAbortError(failure)) setError(errorText(failure)); }
    finally { if (operation.valid()) setBusy(false); }
  }
  async function accept() {
    if (!request?.candidate || request.previewRevision === null) return;
    const current = request, preview = request.previewRevision, candidate = request.candidate, operation = begin();
    if (acceptance.current?.requestId !== current.id || acceptance.current.preview !== preview) acceptance.current = { requestId: current.id, preview, key: crypto.randomUUID() };
    try {
      const result = await client.acceptCompanyRequest(current.id, { candidateId: candidate.id, previewRevision: preview }, acceptance.current.key, operation.abort.signal);
      if (operation.valid()) { setRequest(result); pending.current = null; }
    } catch (failure) { if (operation.valid() && !isAbortError(failure)) setError(errorText(failure)); }
    finally { if (operation.valid()) setBusy(false); }
  }
  const reset = useCallback(() => {
    generation.current++; controller.current?.abort(); pending.current = null; acceptance.current = null;
    setRequest(null); setError(''); setBusy(false);
  }, []);
  async function reject() {
    if (!request) { reset(); return; }
    const operation = begin();
    try { await client.deleteCompanyRequest(request.id, operation.abort.signal); if (operation.valid()) reset(); }
    catch (failure) { if (operation.valid() && !isAbortError(failure)) setError(errorText(failure)); }
    finally { if (operation.valid()) setBusy(false); }
  }
  return { request, error, busy, resolveLookup, refresh, accept, reject, reset };
}
