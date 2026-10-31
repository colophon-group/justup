// Compiler hints are optional; source verification remains authoritative on every page.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeTask, decodeResults, decodeSearch } from "./decode.ts";
const warning = (prefill: unknown, code = "company_not_found") => ({
  code,
  message: "Company is outside our catalogue.",
  companyRequestPrefill: prefill,
});
const search = (warnings: unknown[]) => ({
  id: "s",
  revision: 1,
  query: "Jobs at a company",
  title: "Company jobs",
  status: "ready",
  warnings,
});
test("company-not-found hints survive search and proposal decoding with bounded plain strings", () => {
  const warnings = [
    warning({ input: "  New company  ", scope: " European division " }),
    warning({ input: "x".repeat(200), scope: null }),
  ];
  const accepted = decodeSearch(search(warnings));
  const proposal = decodeTask({
    id: "t",
    kind: "search_intent",
    status: "warning",
    error: null,
    result: {
      proposal: {
        ...search(warnings),
        proposalId: "p",
        searchId: "s",
        expectedRevision: 1,
      },
    },
  }).result;
  assert.ok(proposal && "proposal" in proposal);
  for (const decoded of [accepted, proposal.proposal]) {
    assert.deepEqual(decoded.warnings[0]?.companyRequestPrefill, {
      input: "New company",
      scope: "European division",
    });
    assert.equal(decoded.warnings[1]?.companyRequestPrefill?.input.length, 200);
  }
});
test("malformed or unrelated optional hints leave the ordinary warning usable", () => {
  const malformed = [
    null,
    [],
    "Company",
    {},
    { input: "Company" },
    { input: "", scope: null },
    { input: "   ", scope: null },
    { input: "x".repeat(201), scope: null },
    { input: "Company\nname", scope: null },
    { input: "Company", scope: "" },
    { input: "Company", scope: "x".repeat(201) },
    { input: "Company", scope: "scope\u0085" },
    { input: 2, scope: null },
  ];
  for (const prefill of malformed) {
    const decoded = decodeSearch(search([warning(prefill)]));
    assert.equal(
      decoded.warnings[0]?.message,
      "Company is outside our catalogue.",
    );
    assert.equal(decoded.warnings[0]?.companyRequestPrefill, undefined);
  }
  assert.equal(
    decodeSearch(
      search([warning({ input: "Company", scope: null }, "unrelated")]),
    ).warnings[0]?.companyRequestPrefill,
    undefined,
  );
});
test("result pages retain nullable source verification without changing continuation states", () => {
  const page = {
    searchId: "s",
    revision: 1,
    items: [],
    continuation: { state: "paused", cursor: null, retryAfterMs: 5000 },
    ai: { status: "dependency_unavailable" },
    coverage: {
      state: "import_unavailable",
      description: "Imported listings need verification.",
      stale: true,
      verifiedAt: null,
    },
  };
  assert.deepEqual(decodeResults(page).coverage, page.coverage);
  assert.equal(decodeResults(page).continuation.state, "paused");
  assert.equal(
    decodeResults({
      ...page,
      coverage: undefined,
      continuation: { ...page.continuation, state: "exhausted" },
    }).coverage,
    undefined,
  );
});
