---
summary: Implement, test and independently qualify the bounded Hiring Wire Sol subscription transport.
read_when: Integrating Hiring Wire with the private model broker or reviewing its runtime evidence.
---

# Hiring Wire subscription runtime

Hiring Wire uses one ephemeral Codex **0.159.2** app-server process and one
`gpt-6.1-sol` conversation per edition attempt. This is the ChatGPT subscription
CLI path. It does not call the Responses API directly, accept an API key, run a
shell tool, start an MCP service, or depend on conversation history. The product
owns aggregates, prior editions, its versioned selection recipe and publication.
See [the edition contract](hiring-wire.md) for those responsibilities.

The concrete transport is implemented and tested with synthetic streams and local
private sockets. **The profile remains unqualified by default.** No native model
run, account-availability check, provider request capture, protected host check,
service activation or production-history read was performed for this change.
Source-history availability remains a separate dependency in issue 71. A fixed
model name in shipped metadata establishes a supported client policy; it does not
establish account entitlement, actual provider routing or editorial quality.

## Integrate with the existing worker

The queue process constructs
`createHiringWireCodexTransport({config:{...hiringWire,buildIdentity,hostPlanSha256}})`
from `server/hiring-wire-codex-broker.mjs`, then passes it to
`createHiringWireEditorial({transport})`. The API never receives broker credentials
or launches the CLI. The queue's `hiring_wire` work must wait while interactive
search/company work is pending. Task claiming and the weekly scheduler belong to
central worker composition; this module does not add an independent scheduler.

The existing `server/model-broker.mjs` listener accepts Wire on its inherited
**FD 3**, under the existing model UID. Intent, company research and the entire
Wire conversation share its existing single `busy` guard. Wire holds that slot
while waiting for dispatcher tool results and during cleanup. Existing Luna
one-frame requests and their independent qualification remain unchanged.
`broker.close()` aborts sockets and waits for invocation cleanup. An in-progress
Wire attempt is bounded; queued interactive work must be preferred at admission.

The broker reuses its private auth handling: create a mode-0700 invocation, copy
only validated subscription `auth.json` into a new home, preserve only validated
refresh state, and delete the complete invocation in `finally`. Startup scratch
recovery removes abandoned owned invocations. The transport never reads auth.
Pinned app-server has no `--ignore-user-config` option, so a fresh auth-only home
and the existing immutable empty working directory are required. No operator
should copy authentication into another workspace. CLI children receive only
HOME, CODEX_HOME, TMPDIR, a fixed PATH, locale and color settings; no database,
SSH, Docker, proxy, administration or API-key environment is inherited. Child
stdio contains only stdin/stdout/stderr; the listening descriptor is not passed.

## Fixed configuration and qualification

The existing broker JSON and queue configuration may contain `hiringWire`.
Absent or exactly `{ "enabled": false }` leaves it unavailable. The enabled
shape has exactly these five keys:

| Key | Meaning |
| --- | --- |
| `enabled` | Must be `true`; this alone cannot qualify the profile. |
| `attestationPath` | Independent root-reviewed immutable Wire proof. |
| `providerCatalogueSha256` | Actual observed complete provider-catalogue hash. |
| `modelUid` | Existing dedicated model UID; broker checks its actual UID. |
| `socketPath` | Existing root-created private model socket. |

Build identity and host-plan hash come from the existing trusted `JUSTUP_*`
runtime identity, outside that nested object. There are no caller-selected
commands, modules, schema paths, model/provider names, URLs or environment maps.
The preview launchers fix the socket at
`/srv/justup_preview/broker/model.sock`, the model-side proof at
`/srv/justup_preview/model/config/hiring-wire-reviewed.json`, and the sanitized
queue proof at `/srv/justup_preview/broker/hiring-wire-reviewed.json`.
No proof file or observed provider hash is checked in or manufactured.

`wireProfileReady()` requires the socket's existing root-owned private boundary
and an immutable regular proof file: no symlink, one hard link, bounded bytes,
stable file identity, root owner, no write bits, and root-owned parent directories
without group/world writes. `wireAttestationMatches()` checks this exact report:

- `version:1`, `approved:true`, `profile:'hiring_wire'`, `model:'gpt-6.1-sol'`,
  CLI/source/Node/policy versions, exact artifact and host identities, socket,
  actual model UID, `fd:3`, and `executorBoundary:'dedicated_uid_broker'`.
- Exact `WIRE_PROFILE_DESCRIPTOR`, fixed model catalogue hash and dynamic-tool
  declaration hash. The descriptor binds the actual exported `WIRE_TOOLS` hash,
  prompt/tool versions, 90 seconds, 12 calls, and input/output byte bounds.
- `providerCatalogue:{verified:true,transport:'responses_lite',sha256,
  toolSchemaSha256,stockTools:0,tools:[...]}`. `tools` is exactly the five sorted
  Wire names and `sha256` matches the configured **observed** hash.
- True `deniedPathsVerified`, `retentionVerified`, `qualityVerified` and
  `sharedSlotVerified` from review of this exact candidate and host boundary.

A Luna report cannot match this shape. A model-authored receipt cannot qualify it.
The dispatcher creates the trusted execution receipt after validating selections;
the native model returns only snapshot/fact/angle selections. A flag or protocol
fixture cannot establish the actual tool catalogue. Responses Lite places tools
in `additional_tools`, so inspection must include that carrier, top-level tools,
namespaces and any metadata inventory, and reject unknown carriers. No actual
provider catalogue has been observed for this profile yet.

## Pinned protocol and policy

Official [app-server documentation](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)
describes experimental `dynamicTools`. Implementation is bound to primary source
commit `ff6aec96948b70d94983af2641a6b67c94faeff5`:

| Contract | Pinned primary source |
| --- | --- |
| Experimental `thread/start.dynamicTools`, ephemeral thread, empty environments | [thread.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) |
| Canonical function declarations and typed result content | [dynamic_tools.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/dynamic_tools.rs) |
| Server `item/tool/call` RPC | [common.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/app-server-protocol/src/protocol/common.rs) |
| Dynamic handler and function registration | [dynamic.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/tools/handlers/dynamic.rs), [spec_plan.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/tools/spec_plan.rs) |
| CLI stdio/strict-config options and clean-home requirement | [main.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/cli/src/main.rs) |
| Sol metadata and selectors | [models.json](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/models-manager/models.json), [openai_models.rs](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/openai_models.rs) |

The session initializes experimental API support, starts one ephemeral Sol thread,
and starts one turn with the actual `WIRE_SELECTION_SCHEMA`. Its only dynamic
functions are `read_facts`, `read_prior_editions`, `read_selection_script`,
`replace_selection_script` and `preview_selection`. It relays a server request's
`callId`, function name and validated arguments to the existing dispatcher. The
next step must contain the exact accumulated `{id,name,result}` messages, with
unchanged snapshot/context/instructions. The reply uses the separate JSON-RPC
request ID and `{contentItems:[{type:'inputText',text:JSON.stringify(result)}],
success:true}`. Parallel calls are delivered in batches of at most four.

`turn/completed` must follow a valid final agent message and valid reported token
usage. Foreign thread/turn IDs, duplicate calls, unsolicited server requests,
stock tool items, protocol drift, invalid UTF-8, malformed results, extra claims
and factually wrong angles fail closed. All five tool arguments use the actual
Wire schemas. Read results match the fixed aggregate/public contexts, recipes
match their schema/hash, replacements match the requested recipe and preview
selections reference valid facts. No tool accepts raw paths, SQL or shell.

The fixed Sol catalogue preserves the complete shipped record except seven tool
selectors: direct tool mode, disabled shell, no patch tool, no experimental tools,
disabled node REPL, no multi-agent selector and no tool search. `use_responses_lite`
and all non-tool model metadata remain intact. Native shell disabling requires
both `ShellTool` off and `shell_type:'disabled'`: merely disabling unified exec
is insufficient. Features/config also disable utilities, plan, async input,
clock, sleep, token/context tools, permissions, agents, skills, MCP, apps/plugins,
web/image/browser/computer tools, code mode, hooks, memories and remote control.
The code checks pinned CLI version/home, model/provider, empty instruction
sources, read-only sandbox, no network access, disabled plugins and ephemeral
thread in protocol responses. This is static policy plus runtime validation,
not evidence of the provider request actually offered to a model.

| Identity | SHA256 |
| --- | --- |
| Shipped Sol record, canonical JSON | `4c65b06042eb8a47682708ec1fb86dc537676fa358830500f8e3c3c0840fbc03` |
| `hiring-wire-sol-catalogue.json` file bytes | `5ed662f51bb5a9eda38e52fae474954574504286a851bfbad4a4aa6d32b4ed61` |
| Exact Wire tool schemas | `e411813b3c2b73b84fb7871550d22c8c37f28cb4eaa8903c3696f5df08f9b0f4` |
| Canonical app-server dynamic declarations | `f3deb93a0fb67d8bb2861a7d0938e678384b1144964ed3bcd6bcf6cba59f3b56` |

These hashes have different meanings. None is an observed provider-request hash.
The release must package `hiring-wire-codex.mjs`,
`hiring-wire-codex-policy.mjs`, `hiring-wire-codex-broker.mjs`, the fixed Sol JSON,
Wire's facts/editorial modules and the existing model runner/broker dependencies.
There is no arbitrary helper discovery or module-path configuration.

## Bounds, cleanup and measurement

One conversation has a global 90-second deadline, at most 12 function calls,
65,536-byte tool/final responses and 262,144-byte complete step requests. Aggregate
context has at most 64 companies and eight prior public editions. The dispatcher
separately limits recipe updates to four and retains 32 durable recipe versions.
Native stdout and input are each bounded to 524,288 bytes; stderr to 16,384 bytes.
Private frames are bounded and the whole socket session is at most 4 MiB inbound.
No stdout/stderr, argument/result content, labels, prompts, account data or paths
are retained by diagnostics.

Observed token usage is limited to 6,000 output tokens and 98,304 total tokens.
Exceeding reported usage rejects the attempt. These are observation checks after
usage is reported, **not a provider-enforced generation or monetary budget**.
The native CLI does not expose a proven hard token-budget control for this path.
Counters expose duration, bytes, calls and reported token usage; subscription
cost/remaining allowance and editorial latency/quality have not been measured.
The existing preview resource ceiling remains unchanged: 50% CPU, 1 GiB RAM,
96 tasks and 2 GiB disk under `/justup.slice/justup-preview.slice`.

Failure, abort, disconnect, final completion and dispatcher `finally` cancel the
session. Cleanup closes stdin, sends SIGTERM to the actual process group, waits
100 ms and sends SIGKILL even if the direct child exited. Before destroying
streams it waits up to two more seconds for the child's close
event and a process-group probe returning `ESRCH`. Unexpected signal/probe errors
or a surviving child/group fail with `cleanup_unproven` and quarantine the shared
slot. The broker releases the slot only after native cleanup and private invocation
cleanup, then sends `type:"cancelled"` or a terminal reply marked `cleanup:"complete"`.
The client awaits that proof for at most five seconds; socket closure alone never
proves cleanup. Repeated cancellation shares the same pending result. Unproven
cleanup prevents queue handoff to interactive work and requires runtime recovery.
Protected host UID, descriptor/network isolation, descendant termination
and real trace retention still need evidence from the exact deployed candidate.

Protocol evaluation version `hiring-wire-codex-protocol-eval-v1` covers the five
tool workflow, recipe revision, parallel call IDs, context/message tampering,
unknown/stock tools, byte/token limits, wrong claims, cancellation and shared-slot
admission. The acceptance threshold is zero failed deterministic protocol cases.
Wire's separate versioned factual cases cover coverage gaps and zero baselines.
Neither fixture suite establishes native editorial quality. Root review must
choose and run representative plus held-out editorial cases with factual-claim
error rate zero, then record selection usefulness, variance, duration and tokens
before setting `qualityVerified:true`. No live-model quality or cost result is
claimed here.

Run the focused suites with the pinned Node **24.22.2**:

```sh
node --test server/hiring-wire-codex.test.mjs server/hiring-wire-codex-broker.test.mjs server/model-broker.test.mjs
```

Tests use fake app-server streams and temporary local sockets only. Full server
regressions additionally cover the existing intent/company contracts and edition
consumer. A local run on another Node version is protocol evidence only and does
not satisfy the pinned-runtime qualification requirement.
