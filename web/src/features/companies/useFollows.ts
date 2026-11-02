// One account-owned follow snapshot serves catalogue actions and search invalidation.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ApiClient, isAbortError } from '../../api/client.ts';
import type { FollowSnapshot, Session } from '../../api/types.ts';
export interface FollowControl {
  available: boolean;
  disabled: boolean;
  busy: boolean;
  error: string;
  items: ReadonlySet<string>;
  change: (companyId: string, followed: boolean) => Promise<void>;
  retry: () => void;
  invalidation: { sequence: number; ids: string[] | null };
}
export function useFollows(client: ApiClient, session: Session | null): FollowControl {
  const owner = session?.user?.id ?? null, available = !!owner && session?.capabilities.follows === true;
  const [snapshot, setSnapshot] = useState<FollowSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [invalidation, setInvalidation] = useState<FollowControl['invalidation']>({ sequence: 0, ids: [] });
  const active = useRef<AbortController | null>(null), generation = useRef(0), currentOwner = useRef(owner);
  currentOwner.current = owner;
  const invalidate = (ids: string[] | null) => setInvalidation(previous => ({ sequence: previous.sequence + 1, ids }));
  useEffect(() => {
    const stop = client.onSessionSuspended(() => { active.current?.abort(); setBusy(true); });
    const resume = client.onSessionResumed(() => setAttempt(value => value + 1));
    return () => { stop(); resume(); };
  }, [client]);
  useLayoutEffect(() => {
    const sequence = ++generation.current;
    active.current?.abort(); setSnapshot(null); setError(''); setBusy(false);
    if (!available || !owner) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    client.getFollows(controller.signal).then(result => {
      if (controller.signal.aborted || sequence !== generation.current || currentOwner.current !== owner) return;
      if (result.accountId !== owner) throw new Error('Unexpected follow owner');
      setSnapshot(result); invalidate(null);
    }).catch(failure => {
      if (!controller.signal.aborted && sequence === generation.current && !isAbortError(failure)) setError('Company follows are unavailable. Reload follows to try again.');
    }).finally(() => { if (!controller.signal.aborted && sequence === generation.current) { active.current = null; setBusy(false); } });
    return () => { controller.abort(); active.current?.abort(); generation.current++; };
  }, [client, owner, available, attempt]);
  const change = async (companyId: string, followed: boolean) => {
    if (!available || !owner || active.current || error || !snapshot || snapshot.accountId !== owner || client.isSessionSuspended()) return;
    const sequence = ++generation.current, controller = new AbortController(); active.current = controller;
    const valid = () => !controller.signal.aborted && sequence === generation.current && currentOwner.current === owner;
    setBusy(true); setError('');
    try {
      const result = await client.updateFollow(companyId, followed, snapshot.revision, controller.signal);
      if (!valid()) return;
      if (result.accountId !== owner || result.revision < snapshot.revision || result.items.some(item => item.companyId === companyId) !== followed) throw new Error('Unexpected follow acknowledgement');
      setSnapshot(result);
      // Stale same-choice requests can succeed without this request changing
      // anything. Gaps/empty invalidation may hide changes made by another tab.
      invalidate(result.revision === snapshot.revision + 1 && result.invalidatedSearchIds.length ? result.invalidatedSearchIds : null);
    } catch (failure) {
      if (!valid() || isAbortError(failure)) return;
      // A lost response may have committed. Reconcile without repeating a write;
      // explicit reload remains required before another choice is enabled.
      setError('The follow change could not be confirmed. Reload follows before trying again.');
      invalidate(null);
      try { const result = await client.getFollows(controller.signal); if (valid() && result.accountId === owner) setSnapshot(result); } catch { /* Keep the explicit uncertainty and reload action. */ }
    } finally { if (valid()) { active.current = null; setBusy(false); } }
  };
  return { available, disabled: !available || busy || !!error || snapshot?.accountId !== owner, busy, error,
    items: new Set(snapshot?.accountId === owner ? snapshot.items.map(item => item.companyId) : []), change,
    retry: () => setAttempt(value => value + 1), invalidation };
}
