import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError } from "./client.ts";
import { decodeSession, decodeTask, decodeJob } from "./decode.ts";
import { pollTask } from "./tasks.ts";
const session = () =>
  decodeSession({
    user: null,
    csrfToken: "test-only",
    access: { kind: "guest", fullAccess: false, billingEnabled: false },
    capabilities: { search: true },
    authentication: {
      method: "username_password",
      loginEnabled: false,
      registrationEnabled: false,
      reason: "policy_unavailable",
    },
    policies: {
      locale: "en", reviewedLocale: null, fallback: false,
      reviewed: false,
      version: null,
      privacyUrl: null,
      usageUrl: null,
    },
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test("bodyless mutations retain same-origin credentials, JSON and CSRF without storing a session", async () => {
  let calls = 0;
  const client = new ApiClient({
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "/api/v1/session/logout");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.body, "{}");
      assert.equal(new Headers(init?.headers).get("X-CSRF-Token"), "test-only");
      return json({});
    },
  });
  client.setSession(session());
  await client.logout();
  assert.equal(calls, 1);
  client.setSession(null);
  await assert.rejects(
    client.logout(),
    (error) => error instanceof ApiError && error.code === "csrf_unavailable",
  );
  assert.equal(calls, 1);
});
test("invalid credentials remain local while expired authorization clears the session", async () => {
  let expired = 0,
    code = "invalid_credentials";
  const client = new ApiClient({
    onSessionExpired: () => expired++,
    fetch: async () => json({ error: { code, message: "Not allowed." } }, 401),
  });
  client.setSession(session());
  await assert.rejects(client.deleteAccount("wrong"));
  assert.equal(expired, 0);
  code = "unauthenticated";
  await assert.rejects(client.deleteAccount("wrong"));
  assert.equal(expired, 1);
});
test("cancelling a response body preserves AbortError instead of becoming a contract failure", async () => {
  const controller = new AbortController();
  const client = new ApiClient({
    fetch: async () => {
      const response = json({});
      Object.defineProperty(response, "json", {
        value: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      });
      return response;
    },
  });
  await assert.rejects(
    client.getSession(controller.signal),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});
test("task states reject mixed results/errors and unfinished successful envelopes", () => {
  const task = {
    id: "t",
    kind: "search_intent",
    status: "pending",
    result: null,
    error: null,
  };
  assert.equal(decodeTask(task).status, "pending");
  for (const value of [
    { ...task, status: "failed" },
    { ...task, status: "succeeded" },
    { ...task, result: { search: {} } },
  ])
    assert.throws(() => decodeTask(value));
});
test("task polling rejects a different identity before applying a result", async () => {
  const client = new ApiClient({
    fetch: async () =>
      json({
        id: "other",
        kind: "search_intent",
        status: "pending",
        result: null,
        error: null,
      }),
  });
  await assert.rejects(
    pollTask(client, "expected", new AbortController().signal),
    (error) => error instanceof ApiError && error.code === "unexpected_task",
  );
});
test("position sources and first-observed timestamps are validated before use", () => {
  const job = {
    id: "job",
    title: "Librarian",
    company: { id: "company", name: "Library" },
    sourceUrl: "https://example.test/jobs/1",
    firstObserved: "2026-10-31T10:00:00Z",
  };
  assert.equal(decodeJob(job).sourceUrl, job.sourceUrl);
  for (const firstObserved of ["123", "1/2/2026", "2026-02-30T10:00:00Z"])
    assert.throws(() => decodeJob({ ...job, firstObserved }));
  for (const sourceUrl of [
    "javascript:alert(1)",
    "https://user:password@example.test/",
  ])
    assert.throws(() => decodeJob({ ...job, sourceUrl }));
});
test("a delayed unauthorized response from an old account cannot clear a newer session", async () => {
  let release: (response: Response) => void = () => {},
    expired = 0,
    first = true;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = new ApiClient({
    onSessionExpired: () => expired++,
    fetch: async (_url, init) => {
      if (first) {
        first = false;
        return deferred;
      }
      assert.equal(new Headers(init?.headers).get("X-CSRF-Token"), "new-csrf");
      return json({});
    },
  });
  client.setSession(session());
  const pending = assert.rejects(client.deleteSearch("old"));
  client.setSession({
    ...session(),
    csrfToken: "new-csrf",
    user: { id: "new", username: "new-reader" },
  });
  release(
    json(
      { error: { code: "unauthenticated", message: "Old account expired." } },
      401,
    ),
  );
  await pending;
  assert.equal(expired, 0);
  await client.logout();
});
test("cancellation wins even if an injected transport finishes a valid unauthorized body afterward", async () => {
  const controller = new AbortController();
  let expired = 0;
  const client = new ApiClient({
    onSessionExpired: () => expired++,
    fetch: async () => {
      const response = json(
        { error: { code: "unauthenticated", message: "Expired." } },
        401,
      );
      const body = response.json.bind(response);
      Object.defineProperty(response, "json", {
        value: async () => {
          const result: unknown = await body();
          controller.abort();
          return result;
        },
      });
      return response;
    },
  });
  client.setSession(session());
  await assert.rejects(
    client.deleteSearch("s", controller.signal),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(expired, 0);
});

test('only an exact explicit route locale supplies the request header and clearing removes it', async () => {
  const calls: {path: string; headers: Headers; body: BodyInit | null | undefined}[] = [];
  const client = new ApiClient({fetch: async (path, init) => {
    calls.push({path:String(path),headers:new Headers(init?.headers),body:init?.body});
    return json({});
  }});
  client.setSession(session());
  await client.request('/preferences', value => value);
  assert.equal(calls.at(-1)?.headers.has('X-Justup-Locale'), false);
  for (const locale of ['en','de','fr','it','es'] as const) {
    client.setExplicitRequestLocale(locale);
    await client.request('/session', value => value);
    assert.equal(calls.at(-1)?.headers.get('X-Justup-Locale'), locale);
  }
  client.setExplicitRequestLocale('it');
  const query = 'My exact query: accueil, 30h, no weekends';
  await client.request('/searches', value => value, {method:'POST',body:{query}});
  assert.equal(calls.at(-1)?.headers.get('X-Justup-Locale'), 'it');
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.body)), {query});
  for (const invalid of ['esp','it-IT','IT','en,de','it\r\nX-Other: value','',undefined]) {
    assert.throws(() => client.setExplicitRequestLocale(invalid as never), /Invalid explicit interface locale/);
  }
  client.setExplicitRequestLocale(null);
  await client.request('/session', value => value);
  assert.equal(calls.at(-1)?.headers.has('X-Justup-Locale'), false);
  assert.equal(calls.some(call => call.path.includes('locale=')), false);
});
