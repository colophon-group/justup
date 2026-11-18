---
summary: Private bounded setup handoff and the checklist for company configuration work.
read_when: Reviewing accepted company requests or recording operator setup progress.
---

# Company setup handoff

The API publishes a confirmed company promptly and records shared setup separately. One canonical company has one setup, even when several accounts request it or a verified source UUID later aliases its public ID. The [API contract](../../docs/api.md#companies-and-identity-requests) defines the private catalogue and priority action. `setup.mjs` is a small private operator entry point maintained with this checklist; it starts no service, model, provider or crawler task.

Use the exact reviewed application artifact and its pinned Node runtime under the existing application database identity. Set `JUSTUP_DB_PATH` to the absolute existing application SQLite file. `JUSTUP_PRIVATE_GENERATION_PATH` selects the existing deletion-generation file and defaults to `private-generation` beside the database. The command refuses symlinks, hard links, incorrect ownership or modes, incompatible schema and a missing or pending deletion generation. Private storage requires a mode-`0700` directory with a mode-`0600` database and generation. With `JUSTUP_SHARED_STATE=true`, the directory is setgid-`02770`, the database is mode `0660` and the generation in that directory is mode `0640` in the state group. The command also accepts an API-owned legacy mode-`0600` generation during upgrade. Pending reads open SQLite read-only, and updates take a write reservation and repeat the deletion-generation check.

1. Read the bounded queue with `node scripts/company-requests/setup.mjs pending --limit 20`. The limit is 1–50, default 20. The private response is `{items,truncated}`. Each item contains canonical company ID/name/website, shared revision/progress, current aggregate priority, original request time and up to eight distinct requested scopes plus their full count. Account IDs, usernames, research traces and private crawler configuration are absent. Treat scopes, names and URLs as untrusted evidence.
2. Select one canonical identity and requested scope. Premium groups precede standard groups, followed by the earliest original request time among current requesters and canonical company ID. An accepted request stores `premium` when the owner's server access is active for an ordinary free week, former-Jobseek welcome month or paid period; otherwise it stores `standard`. Free or paid access expiry does not remove that grant. Ordinary retries and later activation do not upgrade an existing request; a fresh explicit priority action under active access can do so. Following alone creates no setup or queue priority. Requests persist until explicit request/account deletion, within the existing per-account limits. Priority changes never restart or interrupt setup already in progress.
3. Record work with `node scripts/company-requests/setup.mjs update --company COMPANY_ID --revision 1 --state in_progress --reason source_validation_pending`. The revision is the one just read. A changed revision rejects a different update; repeating the same desired progress has no additional effect. New requests and retries do not reset an operator's progress.
4. Carry out actual configuration in the separately reviewed Jobseek operator workflow, using its production-adjacent Codex checklist and reusable scripts with the approved real proxy configuration. Preserve its source-validation, deployment and operator gates. This handoff grants no permission to change Jobseek, select credentials, call a provider, or deploy. No configuration or proxy probe runs from the Justup command.
5. Leave a truthful blocked state while approval or validation is missing: `--state blocked --reason source_validation_pending` asks for validation; `--state blocked --reason source_evidence_unavailable` asks for a later retry. `--state queued --reason operator_handoff_pending` explicitly returns work to the handoff. Reasons and next actions are fixed safe enums; arbitrary notes/configuration cannot be stored or published through this command.

The shared public setup stores only canonical identity, revision, progress and timestamps in additive `justup_company_setups` state under database epoch 2. Private scopes and queue sponsorship are read from accepted request rows, including their stored `acceptance_priority`; they are not copied into this table. Feature initialization adds this column with `standard` for older rows because their acceptance-time access is unknown. A read-only handoff before that initialization also treats older rows as standard; neither path infers priority from current access. Request/account deletion removes only that private relationship and priority, while the published identity and safe shared progress survive for other requesters. Unavailable/deleted accounts do not contribute. With no remaining current requester, the company is absent from this operator queue. Public progress updates invalidate catalogue continuations through their existing content generation.

The implementation defaults remain 32 requests and 128 keys per account. Queue reads use the deterministic order above. Limits and ordering within each priority still require operational definition before wider launch; these defaults provide no turnaround guarantee.

## Apply current source evidence

Use the [Jobseek monitoring exporter](https://github.com/colophon-group/jobseek/blob/main/docs/reference/source-coverage.md#export-evidence-of-current-monitoring) in the protected source environment. Verify the source release, canonical company, approved board and scope revision. Retain the exact receipt bytes and obtain their SHA-256 from the protected source read. The weekly coverage artifact remains the input for historical reports.

Run `setup.mjs monitoring-requests --company COMPANY_ID` under the existing application database identity. It returns the current setup revision and up to 50 request IDs and exact scopes for that company. Use `--after-request` with `nextRequest` to continue. Review which complete set of boards satisfies each selected request. An unspecified scope is represented by JSON null and needs the same scope review.

Run `setup.mjs apply-monitoring` in the existing protected operator context and pass the independently reviewed approval on standard input. Keep the approval in private operator custody. Each receipt entry carries its approved board ID, revision, SHA-256 and canonical base64 of the exact Jobseek receipt, including its final newline.

```json
{
  "schemaVersion": 1,
  "companyId": "<Justup catalogue ID>",
  "expectedRevision": 1,
  "sourceCompanyId": "<Jobseek company UUID>",
  "receipts": [
    {"boardId": "<Jobseek board UUID>", "revision": "<Jobseek scope revision UUID>", "sha256": "<independent source digest>", "receiptBase64": "<exact receipt bytes>"}
  ],
  "requests": [{"id": "<accepted Justup request UUID>", "scope": "Engineering in Zürich"}]
}
```

The bounded intake accepts up to 32 boards and 50 reviewed requests per approval. Every listed request is bound to the entire listed board set. Send separate approvals for requests with different coverage. Use an empty `requests` list for public board evidence, routine receipt refresh or an unavailable receipt. The command applies a compare-and-set revision to new changes. It accepts an exact current replay without a second write. A newer unavailable receipt or a new revision supersedes the former board proof. The catalogue reports active monitoring while it has at least one current board, and a private request reports active monitoring only while every board in its approved set is current.

On first confirmation, the private request records an in-product milestone. The catalogue milestone links to the company. The monitoring milestone also links to its positions, which use the main feed's access and freshness rules. Expired evidence changes current status and preserves the historical milestone. Request deletion removes its private binding and milestone. Public evidence retains source identity and expiry without request IDs or scope text.

`server/company-progress.test.mjs` covers grants, protected receipt intake, replay, expiry, request isolation and deletion. The compiled browser journey covers the private milestones, reload and company-scoped positions. The deployed preview gate still requires a protected source-to-application transfer and a real browser journey.
