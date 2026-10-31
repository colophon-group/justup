// Company evidence is displayed without inferring locations, history or source ownership.
export function coverageLabel(state: string | undefined): string {
  if (state === 'imported_snapshot') return 'Imported snapshot';
  if (state === 'requested') return 'Identity requested · collection not confirmed';
  if (state === 'monitoring') return 'Monitoring';
  return 'Coverage not reported';
}
export function safeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function reportDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'Not reported';
}
