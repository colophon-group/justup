// Reconcile a bounded prefix without losing paginated rows or inventing arrivals.
import type { Job } from '../../api/types.ts';
import type { LiveSnapshot } from '../../api/liveResults.ts';
export interface LiveBaseline { accepted: Set<string>; complete: boolean }
// Decoded timestamps are UTC; preserve fractional precision beyond Date's milliseconds.
const timestampOrder = (value: string) => value.slice(0, 19) + (value.match(/\.(\d+)(?:Z|\+00:00)$/)?.[1] ?? '').padEnd(9, '0');
export const jobOrder = (a: Job, b: Job): number => {
  const first = timestampOrder(a.firstObserved), second = timestampOrder(b.firstObserved);
  return first > second ? -1 : first < second ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
export function reconcileLive(jobs: Job[], event: LiveSnapshot, baseline: LiveBaseline | null): { jobs: Job[]; baseline: LiveBaseline; arrivals: string[] } {
  const retained = new Set(event.reconciliation.retainedItemIds), byId = new Map(jobs.map(job => [job.id, job]));
  if (event.reconciliation.complete) for (const id of byId.keys()) if (!retained.has(id)) byId.delete(id);
  const arrivals: string[] = [];
  for (const item of event.page.items) {
    const previous = byId.get(item.id);
    // Only a complete preceding enumeration proves that this is newly accepted.
    const isNew = previous ? previous.isNew === true : !!(baseline?.complete && !baseline.accepted.has(item.id));
    if (isNew && !previous) arrivals.push(item.id);
    byId.set(item.id, { ...item, isNew });
  }
  return { jobs: [...byId.values()].sort(jobOrder), arrivals,
    baseline: { accepted: retained, complete: event.reconciliation.complete } };
}
