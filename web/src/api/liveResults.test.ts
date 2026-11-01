// Bounded live transport contracts, independent of browser rendering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from './client.ts';
import { decodeLiveSnapshot, decodeLiveUnavailable, LiveFrameParser, liveResultsPath, readLiveResults, type EventFrame } from './liveResults.ts';
const id = 'A'.repeat(43);
const envelope = () => ({ schemaVersion: 1, scope: 'active_search', searchId: 's', revision: 1, asOf: '2026-11-02T12:00:00Z', reason: 'changed', searches: [{ searchId: 's', revision: 1, items: [], continuation: { state: 'exhausted', cursor: null }, reconciliation: { complete: true, retainedItemIds: [] } }] });
test('event decoder rejects foreign revisions, unbounded prefixes, invalid reconciliation and unsupported events', () => {
  assert.equal(decodeLiveSnapshot(envelope(), 's', 1).reason, 'changed');
  for (const value of [{ ...envelope(), revision: 2 }, { ...envelope(), searches: [] }, { ...envelope(), schemaVersion: 2 }, { ...envelope(), reason: 'fake' }]) assert.throws(() => decodeLiveSnapshot(value, 's', 1));
  assert.throws(() => decodeLiveUnavailable({ schemaVersion: 1, reason: 'zero', retryAfterMs: 1000 }));
  assert.equal(decodeLiveUnavailable({ schemaVersion: 1, reason: 'authority_lost', retryAfterMs: 1000 }), 'authority_lost');
});
test('incremental SSE supports split CRLF, comments and multiline JSON, with bounded unfinished frames', () => {
  const frames: EventFrame[] = [], parser = new LiveFrameParser(frame => frames.push(frame));
  for (const part of [': heartbeat\r\n\r\nretry: 1000\n\nid: ' + id + '\r', '\nevent: snapshot\ndata: {\n', 'data: "ok":true}\n\n']) parser.push(part);
  assert.deepEqual(frames, [{ id, event: 'snapshot', data: '{\n"ok":true}' }]);
  assert.throws(() => new LiveFrameParser(() => {}).push('x'.repeat(1_048_577)));
  const unfinished = new LiveFrameParser(() => {});
  assert.throws(() => { for (let i = 0; i < 2000; i++) unfinished.push('data: ' + 'x'.repeat(1000) + '\n'); });
});
test('stream cancellation releases a waiting reader and rejects JSON transport', async () => {
  let cancelled = false;
  const request = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const reading = readLiveResults(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), request.signal, () => {});
  request.abort(); await reading;
  assert.equal(cancelled, true);
  await assert.rejects(readLiveResults(new Response('{}'), new AbortController().signal, () => {}));
});
test('same-origin transport resumes exact scope with Last-Event-ID and session suspension blocks late chunks', async () => {
  const chunks: Uint8Array[] = [], encoder = new TextEncoder(); let controller!: ReadableStreamDefaultController<Uint8Array>; let options!: RequestInit; let path = '';
  const client = new ApiClient({ fetch: (async (input, init) => {
    path = String(input); options = init!;
    return new Response(new ReadableStream({ start(value) { controller = value; }, cancel() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch });
  const request = new AbortController();
  const reading = client.streamResults('visitor', 's', 1, 'de', id, request.signal, frame => chunks.push(encoder.encode(frame.data)));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(path, liveResultsPath('visitor', 's', 1, 'de'));
  assert.equal((options.headers as Record<string, string>)['Last-Event-ID'], id);
  assert.equal(options.credentials, 'same-origin');
  client.suspendSession();
  try { controller.enqueue(encoder.encode(`id: ${id}\nevent: snapshot\ndata: {}\n\n`)); } catch {}
  await reading; assert.deepEqual(chunks, []);
  await assert.rejects(client.streamResults('account', 's', 1, 'en', null, request.signal, () => {}), { name: 'AbortError' });
});
