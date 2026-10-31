// Search-to-company guidance and source pauses use only deterministic same-origin fixtures.
import { expect, test } from "@playwright/test";
import {
  mockApi,
  search,
  job,
  completed,
  task,
  proposal,
  companyRequest,
} from "./api-fixture.mjs";
const hint = {
  code: "company_not_found",
  message: "This company is not in the catalogue.",
  companyRequestPrefill: { input: "New Museum", scope: "Public exhibitions" },
};
const unavailable = {
  ...completed([]),
  continuation: { state: "paused", cursor: null, retryAfterMs: 5000 },
  coverage: {
    state: "import_unavailable",
    description: "Imported listings need verification.",
    stale: true,
    verifiedAt: null,
  },
  ai: { status: "dependency_unavailable" },
};
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
});
for (const fromProposal of [false, true]) {
  test(`${fromProposal ? "proposal" : "accepted"} warning opens an editable lead without submitting or losing search ownership`, async ({
    page,
  }) => {
    const initial = { ...search(), warnings: fromProposal ? [] : [hint] };
    const calls = await mockApi(page, {
      "GET /searches": { items: [initial] },
      "GET /searches/search-1/results": completed(),
      "PATCH /searches/search-1": {
        search: initial,
        task: task("warning-task"),
      },
      "GET /tasks/warning-task": task("warning-task", "warning", {
        proposal: proposal({ warnings: [hint] }),
      }),
      "POST /company-requests": {
        status: 503,
        body: {
          error: { code: "unavailable", message: "Discovery is unavailable." },
        },
      },
    });
    await page.goto("/");
    await expect(page.locator("[data-job]")).toHaveCount(1);
    const query = fromProposal
      ? "Museum jobs at New Museum"
      : "An unsent detailed search";
    await page.locator("#query").fill(query);
    if (fromProposal) {
      await page.locator("#job-search button[type=submit]").click();
      await expect(page.locator("#confirm-search-proposal")).toBeVisible();
    }
    await page.getByRole("button", { name: "Request this company" }).click();
    await expect(page.locator("#request-query")).toHaveValue("New Museum");
    await expect(page.locator("#request-query")).toBeFocused();
    await expect(page.locator("#request-scope")).toHaveValue(
      "Public exhibitions",
    );
    expect(
      calls.some((call) =>
        [
          "POST /company-requests",
          "DELETE /company-requests/request-1",
        ].includes(call.key),
      ),
    ).toBe(false);
    await page.locator("#request-query").fill("A corrected museum");
    await page.locator("#request-scope").fill("Education team");
    await page.getByRole("link", { name: "Positions", exact: true }).click();
    await expect(page.locator("#query")).toHaveValue(query);
    if (fromProposal)
      await expect(page.locator("#confirm-search-proposal")).toBeVisible();
    await page.goto("/#request");
    await expect(page.locator("#request-query")).toHaveValue(
      "A corrected museum",
    );
    await expect(page.locator("#request-scope")).toHaveValue("Education team");
    await page.getByRole("button", { name: "Find company" }).click();
    await expect(page.locator("#request-status")).toContainText(
      "Discovery is unavailable",
    );
    const first = calls.find((call) => call.key === "POST /company-requests");
    expect(first.body).toMatchObject({
      input: "A corrected museum",
      scope: "Education team",
    });
    await page.getByRole("button", { name: "Find company" }).click();
    await expect
      .poll(
        () =>
          calls.filter((call) => call.key === "POST /company-requests").length,
      )
      .toBe(2);
    expect(
      calls.filter((call) => call.key === "POST /company-requests")[1].body,
    ).toEqual(first.body);
    await page.locator("#request-scope").fill("Education team, part time");
    await page.getByRole("button", { name: "Find company" }).click();
    await expect
      .poll(
        () =>
          calls.filter((call) => call.key === "POST /company-requests").length,
      )
      .toBe(3);
    const changed = calls.filter(
      (call) => call.key === "POST /company-requests",
    )[2].body;
    expect(changed.scope).toBe("Education team, part time");
    expect(changed.input).toBe(first.body.input);
    expect(changed.requestKey).not.toBe(first.body.requestKey);
    await page.getByRole("link", { name: "Positions", exact: true }).click();
    await expect(page.locator("#query")).toHaveValue(query);
    await expect(page.locator("[data-job]")).toHaveCount(1);
    expect(
      calls.filter((call) => call.key === "GET /searches/search-1/results"),
    ).toHaveLength(1);
  });
}
test("unverified empty import is paused until manual retry returns a genuinely completed zero", async ({
  page,
}) => {
  let attempts = 0;
  const calls = await mockApi(page, {
    "GET /searches": { items: [search()] },
    "GET /searches/search-1/results": () =>
      ++attempts === 1 ? unavailable : completed([]),
  });
  await page.goto("/");
  await expect(page.locator("#feed-status")).toContainText(
    "Imported listings need verification.",
  );
  await expect(page.locator("#feed-status")).not.toContainText(
    "completed search",
  );
  await expect(page.locator("[data-job]")).toHaveCount(0);
  expect(calls.filter((call) => call.key.endsWith("/results"))).toHaveLength(1);
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.locator("#feed-status")).toContainText(
    "No matching positions found in the completed search.",
  );
  await expect(page.locator("#resume-results")).toHaveCount(0);
});
test("a newly stale page clears visible jobs and discards unverified page items before cursor validation; retry can return the same ids", async ({
  page,
}) => {
  let attempts = 0;
  const calls = await mockApi(page, {
    "GET /searches": { items: [search()] },
    "GET /searches/search-1/results": () => {
      attempts++;
      if (attempts === 1)
        return {
          ...completed([job(1)]),
          hidden: { count: 9, exact: true },
          coverage: { stale: false, verifiedAt: "2026-10-31T08:00:00Z" },
          continuation: { state: "open", cursor: "next", retryAfterMs: null },
        };
      if (attempts === 2)
        return {
          ...unavailable,
          items: [job(2)],
          continuation: { state: "paused", cursor: "next", retryAfterMs: 5000 },
        };
      return completed([job(1)]);
    },
  });
  await page.goto("/");
  await expect(page.locator("[data-job]")).toHaveCount(1);
  await page.locator("#query").fill("Unsent search detail");
  await page.locator("#feed-tail").scrollIntoViewIfNeeded();
  await expect(page.locator("#feed-status")).toContainText(
    "Imported listings need verification.",
  );
  await expect(page.locator("[data-job]")).toHaveCount(0);
  await expect(page.locator("#feed-status")).not.toContainText("repeated");
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.locator("[data-job]")).toHaveCount(1);
  await expect(page.locator("#feed")).toContainText("Librarian 1");
  await expect(page.locator("#query")).toHaveValue("Unsent search detail");
  expect(
    calls
      .filter((call) => call.key.endsWith("/results"))[2]
      .url.searchParams.has("cursor"),
  ).toBe(false);
});
test("prefill replaces only local discovery state and sends no rejection or new request until submit", async ({
  page,
}) => {
  const calls = await mockApi(page, {
    "GET /searches": { items: [{ ...search(), warnings: [hint] }] },
    "GET /searches/search-1/results": completed(),
    "POST /company-requests": { request: companyRequest() },
  });
  await page.goto("/#request");
  await page.locator("#request-query").fill("Old candidate");
  await page.getByRole("button", { name: "Find company" }).click();
  await expect(page.locator("#accept-company")).toBeVisible();
  await page.getByRole("link", { name: "Positions", exact: true }).click();
  await page.getByRole("button", { name: "Request this company" }).click();
  await expect(page.locator("#request-query")).toHaveValue("New Museum");
  expect(
    calls.filter((call) => call.key === "POST /company-requests"),
  ).toHaveLength(1);
  expect(calls.some((call) => call.key.startsWith("DELETE"))).toBe(false);
});

test("session expiry clears a compiler-prefilled lead and scope without starting discovery", async ({
  page,
}) => {
  const calls = await mockApi(page, {
    "GET /searches": { items: [{ ...search(), warnings: [hint] }] },
    "GET /searches/search-1/results": completed(),
    "POST /session/logout": {
      status: 401,
      body: {
        error: { code: "session_expired", message: "Your session expired." },
      },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Request this company" }).click();
  await expect(page.locator("#request-query")).toHaveValue("New Museum");
  await expect(page.locator("#request-scope")).toHaveValue(
    "Public exhibitions",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#sign-in-dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Close sign in", exact: true })
    .click();
  await expect(page.locator("#request-query")).toHaveValue("");
  await expect(page.locator("#request-scope")).toHaveValue("");
  expect(calls.some((call) => call.key === "POST /company-requests")).toBe(
    false,
  );
});
