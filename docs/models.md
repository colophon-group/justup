---
summary: Task-specific Codex profiles, company web discovery, broker isolation and model qualification.
read_when: Composing the runner, reviewing a model profile or enabling an independently qualified provider.
---

# Model tasks

Search interpretation and company resolution use pinned Codex **0.159.2**, named model **gpt-6-luna**, low reasoning and scoped ChatGPT subscription authentication. Model availability is off until a reviewed current-build attestation and the applicable quality/isolation/retention checks pass. A policy hash identifies configuration; it does not establish account entitlement, provider availability or an observed tool catalogue.

Use Node 24.22.2. These modules use Node built-ins only. Run the provider-free boundary contracts with:

```sh
node --test server/model-runner.test.mjs server/model-broker.test.mjs
```

The broader service contracts are `server/intent.test.mjs`, `server/companies.test.mjs` and `server/runner.test.mjs`. Tests use isolated local state, fake process JSONL and injected HTTPS; they never copy authentication or call a model. Versioned held-out cases and gates live in `server/evals/`. Their declared live-quality results remain unmeasured until explicitly qualified.

## Choose the task profile

The broker selects a fixed profile from the socket schema ID; callers cannot supply a model, executable, catalogue, working directory, tool policy or environment.

| Profile | Native tools offered | Search mode | Budget |
| --- | --- | --- | --- |
| `search_intent` | None | `disabled` | Zero native tool calls; 30 seconds per inference, at most 6,000 observed output tokens. The intent service permits one bounded repair. |
| `company_resolution` | Only native `web.run` | `live`, low context | Two observed native web starts across the whole company request, at most two inferences, 60 seconds and 6,000 observed output tokens total. Discovery output is at most 512 tokens. |

Both profiles use the same immutable `server/model-catalogue.json` metadata. Its `supports_search_tool:false` disables deferred tool discovery; it does not disable the separate native web executor. Luna uses Responses Lite, which omits hosted Responses web tools. The supported company path registers the native `web.run` namespace when live web and provider namespace/web capabilities are available. Search intent keeps `web_search="disabled"`, so that executor is excluded.

The CLI exposes no supported hard per-call or per-operation web ceiling for this path. The prompts request at most two queries/operations per call, short responses, and only company-identity `search_query`, `open` and `find`. This is a prompt constraint, not an operation allowlist in the native schema. `web.run` has the stock broader schema; there is no custom tool, proxy, hook or replacement provider. JSONL checks count observed starts, reject unrelated completed actions and terminate the process group on an overrun, incomplete call or unexpected tool. A search HTTP request may already be in flight when a start reaches the parent. One call can contain multiple operations, and a completed `search` action does not expose every input operation. These limits must not be described as an exact provider-request, provider-token or monetary cap.

Shell/command, patch/file, browser/computer, MCP/apps/plugins, skills, agents, REPL/code host, image/artifact, plan/input and permission utilities remain disabled by metadata and supported configuration. `unified_exec` can normalize to true in the pinned CLI; `shell_tool=false` is the independent command-registration gate. Runtime event rejection is an additional check, not pre-execution proof that an unexpected tool was absent.

## Search interpretation

Intent receives bounded query/prior-search/capability/repair data without account or billing identifiers or posting bodies. Every user requirement must be accounted for as an ordinary filter, residual matching condition, nonbinding preference or unsatisfied requirement. The strict schema and compiler reject unsupported values, conflicts, missing/unrelated primary bindings and unavailable residual matching. At most one repair is allowed. A model failure or invalid repair preserves the last accepted search and current draft; a valid zero result remains valid. The intent profile cannot use company web discovery to repair a search.

The full catalogue compiler remains authoritative even when the prompt carries a partial relevance projection. A known company with no eligible jobs is still a known identity. An unsatisfied positive company requirement can offer a bounded company-request prefill, which requires the user's form action and never starts monitoring.

## Resolve a company

Known catalogue identities use zero inference calls. Unknown official sites remain unknown. Other requests send exactly `{input,domain,careerUrl,scope}` as bounded task JSON to the broker. Ambiguous names return clarification; no candidate is accepted from a guessed domain or search result alone.

A whole public HTTPS URL or bare hostname in the normal input field becomes an explicit official-site hint. It skips discovery, fetches at most two logical official pages, and makes one grounded decision. The final model normally needs zero native web calls for this path. Conflicting sites ask for clarification; unsafe/private/ATS-only sites cannot bypass validation.

Name-only requests use the private `company-discovery.schema.json` stage. Luna can search current web evidence and return one `discovered_domain`, one or two official source URLs, or clarification/unresolved. A domain requires at least one observed native web call, and each source URL must be safe and match the proposed official domain. These model-returned URLs are discovery hints, not verified provenance. The broker then inspects the domain through its existing trusted HTTPS fetcher and asks for a grounded final decision. Discovery failure stops the task; there is no broader tool or guessed-domain fallback.

Both stages share one deadline, output budget and observed native-call count. The remaining call allowance passes to the next stage; it never resets per inference. A grounded stage can use its remaining web allowance when identity is uncertain, but web results cannot replace fetched-page support. No model-selected URL is fetched after the final decision.

The trusted fetcher permits at most two logical pages, two same-origin redirects per page and 128 KiB per body. It pins a checked public IPv4 address while retaining TLS hostname validation. Private/link-local/reserved/mixed DNS results, IP literals, non-HTTPS URLs, cross-origin redirects, unsupported content types and oversized bodies fail closed. IPv6-only sites stay unresolved. The final prompt retains at most 12 KiB of visible text and title/H1 markers, reduced for URL/JSON size to remain inside the 24,576-byte input cap; truncation is explicit.

A candidate's domain must match the inspected domain. Its website and evidence URLs must be exact fetched URLs. Its name must appear in retained visible content and title/H1 identity text, and correspond to the requested name unless the input is a whole website hint. Unicode numeric entities are bounded and controls/invalid scalars are removed. Mere mentions and page instructions cannot establish identity. Semantic official identity and ambiguity still need held-out model review; these checks do not prove corporate ownership. Only trusted fetched URL/status/byte/hash provenance is stored privately with the request and purged on deletion. Confirmation and later monitoring transitions belong to the company service, not the model broker.

## Operate the isolated broker

`server/main.mjs`, `composition.mjs` and `runner-adapter.mjs` compose API/queue roles. The API receives readiness metadata and cannot launch inference. The queue connects through a root-owned 0660 Unix socket; only its client group has access. The separate non-root model UID has no database, JEV, API, administration or Docker access. Host restrictions must establish these denied paths.

The broker requires systemd activation on exactly FD 3 with matching `LISTEN_PID` and `LISTEN_FDS=1`. `JUSTUP_MODEL_BROKER_CONFIG` selects a root-owned non-writable JSON file containing only `enabled`, `cliVersion`, `codexPath`, `protectedAuthHome`, `invocationRoot` and `taskCwd`. The trusted launcher supplies canonical `JUSTUP_BUILD_ID` and `JUSTUP_HOST_PLAN_SHA256`; operator JSON cannot override them. All paths are canonical absolute paths. The task directory is empty, root-owned and immutable. Auth and invocation directories are private to the model UID.

The socket accepts exactly `{schemaId:'intent'|'company',prompt,timeoutMs}`. The private discovery schema is not a socket entry. Input is at most 24,576 UTF-8 bytes, a frame at most 32,768 bytes, deadline at most 60 seconds, and one task runs globally. Responses contain only schema-validated final data, numeric usage/counts and bounded verification provenance or safe error codes. Raw web content, tool traces and provider exception messages do not cross the socket.

Each request gets private invocation home/scratch. The broker copies only fresh scoped subscription auth from its protected home, invokes `--no-daemon exec --ignore-user-config --strict-config --ephemeral --json --sandbox read-only --output-schema`, and reconstructs the child environment from fixed HOME/CODEX_HOME/TMPDIR/PATH/locale settings. It inherits no API keys, proxies, database, SSH, Docker or administration variables. Existing local/Jobseek auth must not be copied into this boundary.

The parent bounds stdin/stdout/stderr, elapsed time, observed tool starts and completion usage; it sends TERM then KILL to the whole child group, including surviving descendants. The 6,000 output-token check uses actual completed usage, not a provider-side hard cap. Runs copy back only bounded subscription refresh state and remove invocation files after success or failure. Startup removes only owned stale invocation directories and refuses unrelated entries. Crash recovery and retention still need actual host verification. `--ephemeral` is not proof that logs/caches contain no prompts, and no provider zero-retention promise is made.

## Bind policy and qualification to the artifact

The artifact must retain `model-runner.mjs`, `model-broker.mjs`, `model-catalogue.json`, and all three `model-schemas/*.json`: intent, company and company-discovery. The superseded domain-proposal schema is removed. Catalogue SHA256 is `0829441e0714986d05563eb5885fa7f22324eff3bf2446cc6be857a227c96402`. Argument construction rejects missing, changed, symlinked or hardlinked bytes. Broker readiness requires the file and ancestors to be root-owned and non-writable, with no group/world writable ancestor; install the asset as 0444. The fixed path comes from the installed module, never a caller/config path.

The catalogue preserves every non-tool field and model instruction from the public shipped Luna record under the [retained Codex license](../deploy/justup-preview/codex-LICENSE). Seven reviewed selectors restrict shell, patch, experimental utilities, deferred search, tool mode, agent version and REPL. The static manager prevents remote refresh/cache/ETag replacement. This is supported client policy based on public metadata, not account-specific metadata or entitlement proof.

`MODEL_PROFILES` exports the versioned exact policy descriptors and hashes. Current hashes are:

| Profile | `toolPolicySha256` |
| --- | --- |
| `search_intent` | `f9fbda3d5135a678ecfb68f59bf64a52854da040629ea3ce9116ec429b3dedc1` |
| `company_resolution` | `a073f7fab18af21ef90c16bce81a687159da19cda045b2a6f1d19069e45ea559` |

Queue model configuration requires `enabled`, `isolationVerified`, `cliVersion`, `socketPath`, `attestationPath`, and `taskProfiles`. The trusted launcher supplies artifact `buildIdentity` and installed `hostPlanSha256`. Each enabled `taskProfiles.<kind>` contains `{enabled:true,toolPolicySha256,modelCatalogueSha256}` matching the exported descriptor. Company resolution additionally requires `companyResearchVerified:true`.

The root-owned reviewed report binds those same global identities, exact socket, model/version, `approved:true`, `executorBoundary:'dedicated_uid_broker'`, `deniedPathsVerified:true` and `retentionVerified:true`. It repeats each approved task profile and adds `toolProof`:

- Actual complete-wire evidence uses `{kind:'actual_wire',actualWireObserved:true,toolNames,toolCatalogSha256}`. Intent requires the exact empty catalogue hash `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`; company requires only `['web.run']` and a nonempty catalogue hash, backed by the complete-wire verifier and review.
- Reviewed supported policy equivalence uses `{kind:'supported_static_policy',actualWireObserved:false,sourceCommit:'ff6aec96948b70d94983af2641a6b67c94faeff5',toolNames}`. It must not include an observed catalogue hash. Intent's toolNames is `[]`; company's is `['web.run']`.

A sibling profile, an old empty-company proof or a matching arbitrary global hash cannot approve a profile. Missing/stale/mismatched identities stay unavailable independently for each kind. A current model outage must not close existing sessions, account deletion or ordinary feed access. No approved report is generated by tests or by the profile constants.

## Review evidence and qualify the candidate

`server/evals/luna-wire-catalogue.mjs` inspects all pinned tool carriers: top-level Responses tools, Responses Lite AdditionalTools, nested namespaces and optional metadata inventory. Unknown carriers fail. `assertTaskWireCatalogue` requires intent's complete zero offer or exactly one native company `web.run` namespace, with no extra utility/local/hosted tools. Retained diagnostics contain counts/hashes, not messages or schemas. Used-call counts and self-reports cannot establish the offered catalogue.

The pinned source establishes the configuration path: [Luna/native registration](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/tools/spec_plan.rs), [native web configuration](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/ext/web-search/src/extension.rs), [web executor/events](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/ext/web-search/src/tool.rs), [JSONL mapping](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/event_processor_with_jsonl_output.rs), [static manager selection](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/model-provider/src/provider.rs#L557-L579) and [Lite serialization](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/client.rs#L902-L938). [Official OpenAI web-search documentation](https://learn.chatgpt.com/docs/web-search) explains that native web is separate from sandboxed command networking.

Current local evidence is provider-free: schema/grounding checks, exact task routing, complete synthetic catalogue rejection, process/tool/output budgets and profile-specific proof tests. Historical custom-provider Darwin empty-tool captures apply only to the old tool-free profile, not current company web or default-account qualification. This change performs no native capture, inference, authentication, credential read or host action. Current-candidate actual wire, live quality, latency and cost remain unmeasured.

Before enabling either task, review its supported policy or complete actual wire independently, then establish exact default-provider availability, pinned host binary/artifact/installed-plan identity, fresh dedicated-UID authentication, denied private paths, inherited-skill exclusion and success/failure/crash retention. Run the relevant versioned held-out gates with measured usage, latency and variance; require zero ambiguous guesses, unsupported candidates or dropped hard requirements. Rebuild and requalify when the candidate changes. The isolated deployed preview still needs end-to-end request/deletion/resource/browser verification.
