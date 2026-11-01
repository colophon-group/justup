// Bounded lifecycle signals and server-clock deadlines. No identity or query leaves this page.
import type { Session } from '../api/types.ts';

export const SESSION_CHANNEL = 'justup-session';
export const SESSION_INVALIDATED = 'invalidate';
const MAX_TIMER = 2_147_483_647;

export function sessionDeadlineRemaining(session: Session, requestStarted: number, now: number): number | null {
  const serverNow = session.serverTime ? Date.parse(session.serverTime) + Math.max(0, now - requestStarted) : now;
  const candidates = [session.user ? session.expiresAt : session.visitor?.expiresAt, session.access.fullAccess ? session.access.until : null]
    .filter((value): value is string => typeof value === 'string').map(value => Date.parse(value));
  if (!candidates.length) return null;
  return Math.min(...candidates) - serverNow;
}

export function nextSessionDeadline(session: Session, requestStarted: number, now: number): number | null {
  const remaining = sessionDeadlineRemaining(session, requestStarted, now);
  return remaining === null ? null : Math.min(MAX_TIMER, Math.max(0, remaining));
}

export function expiredSessionSnapshot(session: Session, requestStarted = Date.now(), now = Date.now()): boolean {
  const at = session.serverTime ? Date.parse(session.serverTime) + Math.max(0, now - requestStarted) : now;
  return Boolean(session.user && session.expiresAt && Date.parse(session.expiresAt) <= at
    || session.visitor && Date.parse(session.visitor.expiresAt) <= at
    || session.access.fullAccess && session.access.until && Date.parse(session.access.until) <= at);
}

export function openSessionSignals(invalidate: () => void): { notify: () => void; close: () => void } {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.onmessage = event => { if (event.data === SESSION_INVALIDATED) invalidate(); };
      return { notify: () => { try { channel.postMessage(SESSION_INVALIDATED); } catch { /* Resume remains available if the browser closes its channel. */ } }, close: () => channel.close() };
    }
  } catch { /* Browser policy can disable cross-tab channels; use the fixed storage hint. */ }
  const key = 'justup-session-invalidation';
  const receive = (event: StorageEvent) => { if (event.key === key && event.newValue === SESSION_INVALIDATED) invalidate(); };
  window.addEventListener('storage', receive);
  return {
    notify: () => { try { localStorage.setItem(key, SESSION_INVALIDATED); localStorage.removeItem(key); } catch { /* Resume still revalidates when browser storage is unavailable. */ } },
    close: () => window.removeEventListener('storage', receive),
  };
}
