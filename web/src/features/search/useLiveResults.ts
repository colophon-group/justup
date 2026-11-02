// Own one resumable stream per admitted active search; old callbacks cannot cross scopes.
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api/client.ts';
import { decodeLiveSnapshot, decodeLiveUnavailable, validEventId, type LiveSnapshot, type LiveUnavailable } from '../../api/liveResults.ts';
import type { InterfaceLocale } from '../../i18n/locales.ts';
import type { SearchScope } from '../../api/types.ts';
export function useLiveResults({ client, key, searchId, revision, scope, locale, enabled, receive, unavailable }:
  { client: ApiClient; key: string; searchId: string; revision: number; scope: SearchScope; locale: InterfaceLocale; enabled: boolean;
    receive: (event: LiveSnapshot) => void; unavailable: (reason: LiveUnavailable) => void }) {
  const currentScope = useRef('');
  const scopeKey = `${key}:${enabled}`; currentScope.current = scopeKey;
  const callbacks = useRef({ receive, unavailable }); callbacks.current = { receive, unavailable };
  const resume = useRef({ key: '', id: null as string | null, recent: new Set<string>(), failures: 0, blocked: false, retry: 0 });
  const [retry, setRetry] = useState(0), [status, setStatus] = useState<'connecting' | 'live' | 'paused'>('paused');
  useEffect(() => {
    if (resume.current.key !== key) resume.current = { key, id: null, recent: new Set(), failures: 0, blocked: false, retry };
    const state = resume.current;
    if (state.retry !== retry) { state.retry = retry; state.failures = 0; state.blocked = false; }
    let disposed = false, connection: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let gesture = false, settling: ReturnType<typeof setTimeout> | undefined, pending: LiveSnapshot | null = null;
    const apply = (event: LiveSnapshot) => { if (gesture || settling) pending = event; else callbacks.current.receive(event); };
    const settle = () => {
      clearTimeout(settling);
      settling = setTimeout(() => { settling = undefined; if (!gesture && pending && allowed()) { const latest = pending; pending = null; callbacks.current.receive(latest); } }, 120);
    };
    const beginGesture = () => { gesture = true; };
    const endGesture = () => { gesture = false; settle(); };
    const allowed = () => !disposed && currentScope.current === scopeKey && enabled && !state.blocked && !client.isSessionSuspended() && !document.hidden && !document.querySelector('dialog[open]');
    const stop = () => { pending = null; connection?.abort(); connection = null; clearTimeout(timer); timer = undefined; };
    const connect = () => {
      if (!allowed() || connection || timer) return;
      const request = new AbortController(); connection = request; setStatus('connecting');
      void client.streamResults(scope, searchId, revision, locale, resume.current.id, request.signal, frame => {
        if (request.signal.aborted || connection !== request || !allowed()) return;
        if (frame.event === 'snapshot') {
          if (!validEventId(frame.id)) throw new Error('Invalid live event identity');
          const event = decodeLiveSnapshot(JSON.parse(frame.data), searchId, revision);
          if (resume.current.recent.has(frame.id)) return;
          resume.current.id = frame.id; resume.current.recent.add(frame.id);
          while (resume.current.recent.size > 64) resume.current.recent.delete(resume.current.recent.values().next().value!);
          state.failures = 0; setStatus('live'); apply(event);
        } else if (frame.event === 'unavailable') {
          const reason = decodeLiveUnavailable(JSON.parse(frame.data));
          if (reason !== 'reconnect') state.blocked = true;
          setStatus('paused'); callbacks.current.unavailable(reason); request.abort();
        } else throw new Error('Unknown live event');
      }).catch(error => {
        if (!disposed && connection === request && currentScope.current === scopeKey) {
          setStatus('paused');
          if (error instanceof ApiError && [401, 403, 409].includes(error.status)) {
            state.blocked = true; callbacks.current.unavailable(error.status === 401 ? 'authority_lost' : error.status === 409 ? 'search_changed' : 'dependency_unavailable');
          }
        }
      }).finally(() => {
        if (connection !== request) return;
        connection = null;
        if (!allowed()) return;
        if (++state.failures > 8) { state.blocked = true; setStatus('paused'); return; }
        timer = setTimeout(() => { timer = undefined; connect(); }, Math.min(state.failures, 8) * 1000);
      });
    };
    const update = () => { if (allowed()) connect(); else { stop(); if (!disposed) setStatus('paused'); } };
    const suspended = client.onSessionSuspended(update), resumed = client.onSessionResumed(update);
    document.addEventListener('visibilitychange', update); document.addEventListener('toggle', update, true);
    // Dialog changes also cover browsers that omit the native dialog toggle event.
    const observer = new MutationObserver(update); observer.observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
    document.addEventListener('pointerdown', beginGesture, true); document.addEventListener('pointerup', endGesture, true); document.addEventListener('pointercancel', endGesture, true);
    document.addEventListener('touchstart', beginGesture, { passive: true }); document.addEventListener('touchend', endGesture); document.addEventListener('touchcancel', endGesture);
    window.addEventListener('scroll', settle, { passive: true });
    update();
    return () => {
      clearTimeout(settling); pending = null;
      document.removeEventListener('pointerdown', beginGesture, true); document.removeEventListener('pointerup', endGesture, true); document.removeEventListener('pointercancel', endGesture, true);
      document.removeEventListener('touchstart', beginGesture); document.removeEventListener('touchend', endGesture); document.removeEventListener('touchcancel', endGesture); window.removeEventListener('scroll', settle);
      disposed = true; stop(); suspended(); resumed(); observer.disconnect(); document.removeEventListener('visibilitychange', update); document.removeEventListener('toggle', update, true); };
  }, [client, key, searchId, revision, scope, locale, enabled, retry]);
  return { status, reconnect: () => setRetry(value => value + 1) };
}
