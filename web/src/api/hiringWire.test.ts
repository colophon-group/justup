// Public company news must be comparable facts with bounded identities, never guessed history.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeHiringWire } from "./decode.ts";
import type { HiringWireEdition } from "./types.ts";
const published = (): { state: "published"; edition: HiringWireEdition } => ({ state: "published", edition: {
  id: "2026-10-26", title: "Hiring Wire",
  period: { start: "2026-10-19T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z", previousStart: "2026-10-12T00:00:00.000Z" },
  snapshotAt: "2026-10-26T00:00:00.000Z", publishedAt: "2026-10-26T08:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z",
  methodology: "Comparable newly observed listings, not completed hires.",
  items: [{ company: { id: "library", name: "Library", url: "https://example.com/" }, headline: "Library: 3 newly observed listings, compared with 2 the previous week", activity: { current: 3, previous: 2, change: 1, percentageChange: 50 }, scope: "Comparable career pages" }],
} });
test("public editions retain published comparison facts and honest unavailable state", () => {
  assert.deepEqual(decodeHiringWire(published()), published());
  assert.deepEqual(decodeHiringWire({ state: "unavailable", edition: null }), { state: "unavailable", edition: null });
  const zero = published();
  zero.edition.items[0]!.activity = { current: 3, previous: 0, change: 3, percentageChange: null };
  assert.equal(decodeHiringWire(zero).edition?.items[0]?.activity.percentageChange, null);
  const homepage = published();
  homepage.edition.items[0]!.company.url = "https://example.com/about/company/";
  assert.equal(decodeHiringWire(homepage).edition?.items[0]?.company.url, "https://example.com/about/company/");
});
test("malformed news dates, identities, URLs and inconsistent numbers never render as facts", () => {
  const mutations = [
    (v: ReturnType<typeof published>) => { v.edition.period.start = "2026-10-20T00:00:00.000Z"; },
    (v: ReturnType<typeof published>) => { v.edition.id = "2026-02-30"; },
    (v: ReturnType<typeof published>) => { v.edition.publishedAt = "not-a-date"; },
    (v: ReturnType<typeof published>) => { v.edition.snapshotAt = "2026-10-25T00:00:00.000Z"; },
    (v: ReturnType<typeof published>) => { v.edition.expiresAt = "2026-11-03T00:00:00.000Z"; },
    (v: ReturnType<typeof published>) => { v.edition.expiresAt = "not-a-deadline"; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.company.id = "../private"; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.company.url = "javascript:alert(1)"; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.company.url = "https://127.0.0.1/"; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.company.url = "https://example.com/path?source=jobs"; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.activity.current = -1; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.activity.change = 900; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.activity.percentageChange = 500; },
    (v: ReturnType<typeof published>) => { v.edition.items[0]!.headline = "<script>not a headline</script>"; },
    (v: ReturnType<typeof published>) => { v.edition.items.push(v.edition.items[0]!); },
    (v: ReturnType<typeof published>) => { v.edition.items = []; },
  ];
  for (const mutate of mutations) { const value = published(); mutate(value); assert.throws(() => decodeHiringWire(value), /invalid/); }
  for (const url of ["http://example.com/about/", "https://user:password@example.com/about/", "https://office.home/about/",
    "https://example.com/about/#team", "https://example.com/about/?", "https://example.com/about/#", "https://example.com/%0apath"]) {
    const value = published(); value.edition.items[0]!.company.url = url;
    assert.throws(() => decodeHiringWire(value), /invalid/);
  }
  assert.throws(() => decodeHiringWire({ state: "unavailable", edition: published().edition }), /invalid/);
  assert.throws(() => decodeHiringWire({ state: "pending", edition: null }), /invalid/);
});
