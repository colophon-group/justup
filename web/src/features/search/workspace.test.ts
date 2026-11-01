import test from "node:test";
import assert from "node:assert/strict";
import { emptyWorkspace, queryText, workspaceReducer, mergeWorkspaceEdits, savedWorkspace } from "./workspace.ts";
import { salaryText } from "./format.ts";
import type { Search } from "../../api/types.ts";
const search = (id = "s", revision = 1, query = "Library jobs"): Search => ({
  id,
  revision,
  query,
  title: "Library",
  status: "ready",
  requirements: [],
  warnings: [],
});
test("initial hydration respects an empty editor already chosen by the user", () => {
  for (const action of [
    { type: "editing" } as const,
    { type: "new" } as const,
    { type: "query", value: "" } as const,
    { type: "query", value: "   " } as const,
  ]) {
    const current = workspaceReducer(emptyWorkspace(), action);
    const loaded = workspaceReducer(current, {
      type: "loaded",
      searches: [search()],
    });
    assert.equal(loaded.selectedId, null);
    assert.equal(queryText(loaded), queryText(current));
    assert.equal(loaded.searches.length, 1);
  }
  const untouched = workspaceReducer(emptyWorkspace(), {
    type: "loaded",
    searches: [search()],
  });
  assert.equal(untouched.selectedId, "s");
  assert.equal(queryText(untouched), "Library jobs");
});
test("focusing the editor preserves its current query and warned proposal", () => {
  const loaded = workspaceReducer(emptyWorkspace(), {
    type: "loaded",
    searches: [search()],
  });
  const proposal = {
    proposalId: "p",
    searchId: "s",
    expectedRevision: 1,
    query: "Library jobs with an unsupported requirement",
    title: "Library",
    requirements: [],
    warnings: [],
  };
  const draft = workspaceReducer(loaded, { type: "query", value: proposal.query });
  const warned = workspaceReducer(draft, { type: "proposal", proposal });
  const focused = workspaceReducer(warned, { type: "editing" });
  assert.equal(focused.proposal, proposal);
  assert.equal(focused.selectedId, "s");
  assert.equal(queryText(focused), proposal.query);
  assert.equal(workspaceReducer(focused, { type: "editing" }), focused);
});
test("accepted work preserves text typed after submission and removes only the submitted draft", () => {
  let state = workspaceReducer(emptyWorkspace(), {
    type: "query",
    value: "Library jobs",
  });
  state = workspaceReducer(state, {
    type: "query",
    value: "Library jobs with no night shifts",
  });
  state = workspaceReducer(state, {
    type: "accepted",
    search: search(),
    submitted: "Library jobs",
    previousId: null,
  });
  assert.equal(queryText(state), "Library jobs with no night shifts");
  assert.equal(state.searches[0]?.query, "Library jobs");
  assert.match(state.status, /newer edits have not been applied/);
  const unchanged = workspaceReducer(state, {
    type: "accepted",
    search: search("s", 2, "Library jobs with no night shifts"),
    submitted: "Library jobs with no night shifts",
    previousId: "s",
  });
  assert.equal(unchanged.drafts.s, undefined);
});
test("deleting an inactive search preserves current draft, selection and pending state", () => {
  let state = workspaceReducer(emptyWorkspace(), {
    type: "loaded",
    searches: [search(), search("other")],
  });
  state = workspaceReducer(state, { type: "query", value: "Draft text" });
  state = workspaceReducer(state, { type: "busy", value: true });
  state = workspaceReducer(state, { type: "deleted", id: "other" });
  assert.equal(queryText(state), "Draft text");
  assert.equal(state.selectedId, "s");
  assert.equal(state.busy, true);
});
test("deleting the final search returns an empty workspace without regenerating a search", () => {
  const state = workspaceReducer(
    workspaceReducer(emptyWorkspace(), {
      type: "loaded",
      searches: [search()],
    }),
    { type: "deleted", id: "s" },
  );
  assert.equal(state.selectedId, null);
  assert.deepEqual(state.searches, []);
});
test("salary formatting retains source period and one-sided bounds, omitting unknown amounts", () => {
  assert.equal(
    salaryText({ min: 6000, max: null, currency: "CHF", period: "month" }),
    "From CHF 6,000 / month",
  );
  assert.equal(
    salaryText({ min: null, max: 40.5, currency: "EUR", period: "hour" }),
    "Up to EUR 40.5 / hour",
  );
  assert.equal(
    salaryText({ min: null, max: null, currency: "USD", period: "year" }),
    "",
  );
});
test("a delayed initial list cannot replace a search accepted after that list was requested", () => {
  const accepted = workspaceReducer(emptyWorkspace(), {
    type: "accepted",
    search: search("newly-created", 1),
    submitted: "Library jobs",
    previousId: null,
  });
  const delayed = workspaceReducer(accepted, { type: "loaded", searches: [] });
  assert.equal(delayed.selectedId, "newly-created");
  assert.equal(delayed.searches[0]?.revision, 1);
  const edited = workspaceReducer(delayed, {
    type: "accepted",
    search: search("newly-created", 2, "Edited jobs"),
    submitted: "Edited jobs",
    previousId: "newly-created",
  });
  const old = workspaceReducer(edited, {
    type: "loaded",
    searches: [search("newly-created", 1)],
  });
  assert.equal(old.searches[0]?.revision, 2);
});
test("a delayed list cannot resurrect a search deleted after the list started", () => {
  const accepted = workspaceReducer(emptyWorkspace(), {
    type: "accepted",
    search: search(),
    submitted: "Library jobs",
    previousId: null,
  });
  const deleted = workspaceReducer(accepted, { type: "deleted", id: "s" });
  const stale = workspaceReducer(deleted, {
    type: "loaded",
    searches: [search()],
  });
  assert.equal(stale.selectedId, null);
  assert.deepEqual(stale.searches, []);
});
test("explicit conflict review applies only local changes and preserves unrelated remote edits", () => {
  const base = { activeSearchId: null, drafts: { new: "Original", s: "Original search edit" } };
  const local = { activeSearchId: null, drafts: { new: "My edit", s: "Original search edit" } };
  const remote = { activeSearchId: "s", drafts: { new: "Other tab", s: "Unrelated newer edit", extra: "Another saved draft" } };
  assert.deepEqual(mergeWorkspaceEdits(base, local, remote), {
    activeSearchId: "s", drafts: { new: "My edit", s: "Unrelated newer edit", extra: "Another saved draft" },
  });
});
test("returning to a new search preserves its unsent draft", () => {
  let state = workspaceReducer(emptyWorkspace(), { type: "query", value: "Unsent museum search" });
  state = workspaceReducer(state, { type: "loaded", searches: [search()] });
  state = workspaceReducer(state, { type: "select", id: "s" });
  state = workspaceReducer(state, { type: "new" });
  assert.equal(queryText(state), "Unsent museum search");
});
test("an empty first editor needs no durable draft, while real text and cleared saved-search edits remain exact", () => {
  const focused = workspaceReducer(emptyWorkspace(), { type: "editing" });
  assert.deepEqual(savedWorkspace(focused), { activeSearchId: null, drafts: { new: "" } });
  assert.deepEqual(savedWorkspace(focused, true), { activeSearchId: null, drafts: {} });
  const typed = workspaceReducer(focused, { type: "query", value: "  musée jobs\nwithout night shifts  " });
  assert.equal(savedWorkspace(typed).drafts.new, "  musée jobs\nwithout night shifts  ");
  const selected = workspaceReducer(emptyWorkspace(), { type: "loaded", searches: [search()] });
  const cleared = workspaceReducer(selected, { type: "query", value: "" });
  assert.equal(savedWorkspace(cleared).drafts.s, "");
});
test("accepting a canonical query retains the user's original raw draft text", () => {
  const raw = "  Library jobs  ";
  let state = workspaceReducer(emptyWorkspace(), { type: "query", value: raw });
  state = workspaceReducer(state, { type: "submitted", search: search(), previousId: null });
  state = workspaceReducer(state, { type: "accepted", search: search(), submitted: raw, previousId: "s" });
  assert.equal(queryText(state), raw);
  assert.equal(state.searches[0]?.query, "Library jobs");
});
test("pending creation preserves later typing and interrupted proposals restore without another model call", () => {
  let state = workspaceReducer(emptyWorkspace(), { type: "query", value: "Newer text" });
  state = workspaceReducer(state, { type: "submitted", previousId: null, search: { ...search(), status: "pending", revision: 0 } });
  assert.equal(state.selectedId, "s"); assert.equal(queryText(state), "Newer text");
  state = workspaceReducer(state, { type: "accepted", search: search(), submitted: "Library jobs", previousId: "s" });
  assert.equal(queryText(state), "Newer text");
  const proposal = { proposalId: "p", searchId: "s", expectedRevision: 1, query: "Visa support", title: "Library", requirements: [], warnings: [] };
  const restored = workspaceReducer(emptyWorkspace(), { type: "restored", searches: [{ ...search(), proposal }], saved: { activeSearchId: "s", drafts: { s: "Visa support" } }, preserveLocal: false });
  assert.deepEqual(restored.proposal, proposal);
});
