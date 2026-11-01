// An in-memory ownership key; never send it through cross-tab messages or browser storage.
import type { Session } from './types.ts';

export function sessionOwner(session: Session | null): string | null {
  if (!session) return null;
  if (session.user) return `account:${session.user.id}`;
  return session.visitor ? `visitor:${session.visitor.expiresAt}:${session.csrfToken}` : `public:${session.csrfToken}`;
}
