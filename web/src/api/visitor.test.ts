// Explicit visitor routes never substitute an anonymous owner for an account route.
import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "./client.ts";
import { decodeResults, decodeSession, decodeWorkspace } from "./decode.ts";
import { pollTask } from "./tasks.ts";

const search = { id: "s", revision: 1, query: "Library jobs", title: "Library", status: "ready", warnings: [], requirements: [] };
const result = () => ({ searchId: "s", revision: 1, items: [], continuation: { state: "exhausted", cursor: null, retryAfterMs: null }, ai: { status: "not_required" } });
const session = () => decodeSession({
  user: null, visitor: { expiresAt: "2026-11-02T12:00:00.000Z" }, csrfToken: "test-only-csrf",
  access: { kind: "guest", fullAccess: false, billingEnabled: false }, capabilities: { search: true, visitorSearch: true },
  authentication: { method: "username_password", loginEnabled: true, registrationEnabled: true, reason: null },
  policies: { locale: "en", reviewedLocale: "en", fallback: false, reviewed: true, version: "test-only", privacyUrl: "/privacy.html", usageUrl: "/usage.html" },
});

test("visitor searches, task polling and source visits use only their explicit cookie-bound routes", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new ApiClient({ fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const method = init?.method ?? "GET", path = String(url).split("?")[0];
    const body = path?.includes("/tasks/")
      ? { id: "t", kind: "search_intent", status: "succeeded", error: null, result: { search } }
      : path?.endsWith("/results") ? result()
      : method === "DELETE" || path?.endsWith("/viewed") ? {}
      : method === "GET" ? { items: [search] } : { search };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  } });
  client.setSession(session());
  const signal = new AbortController().signal;
  await client.listSearches(signal, "visitor");
  await client.createSearch({ query: search.query, requestKey: "create" }, signal, "visitor");
  await client.editSearch("s", { query: search.query, requestKey: "edit", expectedRevision: 1 }, signal, "visitor");
  await client.confirmSearch("s", { proposalId: "p", expectedRevision: 1 }, "confirm", signal, "visitor");
  await client.getResults("s", 1, "cursor", signal, "visitor");
  assert.deepEqual(await pollTask(client, "t", signal, "visitor"), { search });
  await client.markViewed("j", "visitor", signal);
  await client.deleteSearch("s", signal, "visitor");
  assert.deepEqual(calls.map(call => call.url), [
    "/api/v1/visitor/searches", "/api/v1/visitor/searches", "/api/v1/visitor/searches/s",
    "/api/v1/visitor/searches/s/confirm", "/api/v1/visitor/searches/s/results?revision=1&limit=12&cursor=cursor",
    "/api/v1/visitor/tasks/t", "/api/v1/visitor/viewed", "/api/v1/visitor/searches/s",
  ]);
  for (const call of calls) {
    assert.equal(call.init?.credentials, "same-origin");
    if (call.init?.method !== "GET") assert.equal(new Headers(call.init?.headers).get("X-CSRF-Token"), "test-only-csrf");
    assert.equal(String(call.init?.body).includes("expiresAt"), false);
  }
  assert.equal(calls[6]?.init?.body, JSON.stringify({ jobId: "j" }));
});

test("unknown and pending hidden matches never become a fabricated count or precision", () => {
  for (const hiddenMatches of [
    { status: "exact", count: 4 }, { status: "lower_bound", count: 2 },
    { status: "pending", count: null }, { status: "unavailable", count: null },
  ]) assert.deepEqual(decodeResults({ ...result(), hiddenMatches }).hiddenMatches, hiddenMatches);
  assert.deepEqual(decodeResults(result()).hiddenMatches, { status: "unavailable", count: null });
  for (const hiddenMatches of [
    { status: "pending", count: 0 }, { status: "unavailable", count: 5 },
    { status: "exact", count: null }, { status: "lower_bound", count: -1 },
    { status: "exact", count: "4" }, { status: "unprocessed", count: 0 },
  ]) assert.throws(() => decodeResults({ ...result(), hiddenMatches }), /invalid/);
});

test("expired visitor authority never opens account sign-in or revokes a newer account session", async () => {
  let visitors = 0, accounts = 0, release: (value: Response) => void = () => {};
  const deferred = new Promise<Response>(resolve => { release = resolve; });
  const expired = () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Expired." } }), { status: 401 });
  const client = new ApiClient({ onVisitorExpired: () => visitors++, onSessionExpired: () => accounts++, fetch: async () => deferred });
  client.setSession(session());
  const request = assert.rejects(client.listSearches(undefined, "visitor"));
  client.setSession({ ...session(), user: { id: "reader", username: "tester" }, visitor: null });
  release(expired()); await request;
  assert.equal(visitors, 0); assert.equal(accounts, 0);
  const visitor = new ApiClient({ onVisitorExpired: () => visitors++, onSessionExpired: () => accounts++, fetch: async () => expired() });
  visitor.setSession(session());
  await assert.rejects(visitor.listSearches(undefined, "visitor"));
  assert.equal(visitors, 1); assert.equal(accounts, 0);
});
test("workspace snapshots keep durable recovery records separate from editable drafts", () => {
  const snapshot = {
    revision: 3, state: { activeSearchId: null, drafts: { new: "Current draft" } },
    viewed: [{ jobId: "j", firstViewedAt: "2026-11-01T12:00:00.000Z" }],
    recoveredDrafts: [{ id: "r", text: "Recovered visitor draft", createdAt: "2026-11-01T11:00:00.000Z" }],
  };
  assert.deepEqual(decodeWorkspace(snapshot), snapshot);
  for (const invalid of [
    { ...snapshot, revision: -1 }, { ...snapshot, recoveredDrafts: [...snapshot.recoveredDrafts, ...snapshot.recoveredDrafts] },
    { ...snapshot, state: { activeSearchId: null, drafts: { new: "x".repeat(4001) } } },
    { ...snapshot, viewed: [{ jobId: "j", firstViewedAt: "not-a-date" }] },
  ]) assert.throws(() => decodeWorkspace(invalid), /invalid/);
});
test("only an expected visitor workspace clear can inspect a stale hint without clearing newer field text", async () => {
  let visitorExpired = 0, accountExpired = 0;
  const client = new ApiClient({ onVisitorExpired: () => visitorExpired++, onSessionExpired: () => accountExpired++,
    fetch: async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Expired." } }), { status: 401 }),
  });
  client.setSession(session());
  await assert.rejects(client.saveWorkspace("visitor", { activeSearchId: null, drafts: { new: "" } }, 1, undefined, true));
  assert.equal(visitorExpired, 0);
  await assert.rejects(client.getWorkspace("visitor"));
  assert.equal(visitorExpired, 1);
  client.setSession({ ...session(), user: { id: "reader", username: "tester" }, visitor: null });
  await assert.rejects(client.request("/workspace", value => value, { method: "PATCH", body: {}, expectedVisitorReclamation: true }));
  assert.equal(accountExpired, 1);
});
