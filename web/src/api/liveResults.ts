// Typed, bounded SSE frames. Read when changing reconnect or active-search delivery.
import { ContractError, decodeResults, record } from './decode.ts';
import type { ResultPage } from './types.ts';
import type { InterfaceLocale } from '../i18n/locales.ts';
import type { SearchScope } from './types.ts';
export interface LiveSnapshot {
  schemaVersion: 1;
  scope: 'active_search';
  searchId: string;
  revision: number;
  asOf: string;
  reason: 'initial' | 'resumed' | 'recovery' | 'changed';
  page: ResultPage;
  reconciliation: { complete: boolean; retainedItemIds: string[] };
}
export type LiveUnavailable = 'authority_lost' | 'search_changed' | 'dependency_unavailable' | 'reconnect';
export const validEventId = (id: string) => /^[A-Za-z0-9_-]{43}$/.test(id);
const invalid = (): never => { throw new ContractError('live result event'); };
export function decodeLiveSnapshot(value: unknown, searchId: string, revision: number): LiveSnapshot {
  const event = record(value), searches = event.searches;
  if (event.schemaVersion !== 1 || event.scope !== 'active_search' || event.searchId !== searchId || event.revision !== revision
    || !['initial', 'resumed', 'recovery', 'changed'].includes(String(event.reason))
    || typeof event.asOf !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(event.asOf) || !Number.isFinite(Date.parse(event.asOf))
    || !Array.isArray(searches) || searches.length !== 1) return invalid();
  const page = decodeResults(searches[0]), reconciliation = record(record(searches[0]).reconciliation);
  if (page.searchId !== searchId || page.revision !== revision || page.items.length > 96
    || new Set(page.items.map(item => item.id)).size !== page.items.length
    || typeof reconciliation.complete !== 'boolean' || !Array.isArray(reconciliation.retainedItemIds)
    || reconciliation.retainedItemIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)
    || new Set(reconciliation.retainedItemIds).size !== reconciliation.retainedItemIds.length) return invalid();
  const retainedItemIds = reconciliation.retainedItemIds as string[];
  if (reconciliation.complete && page.items.some(item => !retainedItemIds.includes(item.id))) return invalid();
  return { schemaVersion: 1, scope: 'active_search', searchId, revision, asOf: event.asOf,
    reason: event.reason as LiveSnapshot['reason'], page, reconciliation: { complete: reconciliation.complete, retainedItemIds } };
}
export function decodeLiveUnavailable(value: unknown): LiveUnavailable {
  const event = record(value);
  if (event.schemaVersion !== 1 || event.retryAfterMs !== 1000
    || !['authority_lost', 'search_changed', 'dependency_unavailable', 'reconnect'].includes(String(event.reason))) return invalid();
  return event.reason as LiveUnavailable;
}
export function liveResultsPath(scope: SearchScope, searchId: string, revision: number, locale: InterfaceLocale): string {
  return `/api/v1${scope === 'visitor' ? '/visitor' : ''}/workspace/events?${new URLSearchParams({ searchId, revision: String(revision), locale })}`;
}
export interface EventFrame { event: string; id: string; data: string }
// Bound the undecoded line and complete event, including comments, before JSON parsing.
export class LiveFrameParser {
  private buffer = '';
  private event = '';
  private id = '';
  private data: string[] = [];
  private bytes = 0;
  private readonly receive: (frame: EventFrame) => void;
  constructor(receive: (frame: EventFrame) => void) { this.receive = receive; }
  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_048_576) invalid();
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      this.bytes += new TextEncoder().encode(line).byteLength + 1;
      if (this.bytes > 1_048_576) invalid();
      if (!line) {
        if (this.data.length) this.receive({ event: this.event, id: this.id, data: this.data.join('\n') });
        this.event = ''; this.id = ''; this.data = []; this.bytes = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') this.event = value;
        else if (field === 'id') this.id = value;
        else if (field === 'data') this.data.push(value);
        else if (field === 'retry' && value !== '1000') invalid();
      }
    }
  }
}
export async function readLiveResults(response: Response, signal: AbortSignal, receive: (frame: EventFrame) => void): Promise<void> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream' || !response.body) invalid();
  const reader = response.body!.getReader(), parser = new LiveFrameParser(receive), decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  try {
    while (!signal.aborted) {
      idle = setTimeout(abort, 45_000);
      const { done, value } = await reader.read();
      clearTimeout(idle);
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally { clearTimeout(idle); signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
