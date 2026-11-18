---
summary: Prepare Justup-only phone paging and a local Codex incident watcher.
read_when: Defining alert rules, installing the laptop watcher or rehearsing incident delivery.
---

# Justup incident alerting

The public route and application services are currently off. No Justup alert rule, IRM phone route or laptop watcher is active. This guide prepares the path; activation needs the exact preview release, measured thresholds, a tested phone recipient and the existing release gates. Jobseek production paging remains disabled.

## Delivery and ownership

```text
public route + Justup service signals
             ↓
Grafana Cloud synthetic checks and Justup-only alert rules
             ↓
Grafana IRM Justup critical integration → escalation → mobile push to Viktor
             ↓ (independent, optional)
Mac LaunchAgent → read-only IRM list → one fixed Codex incident prompt
```

Viktor Shcherbakov owns incident acknowledgement and response. The phone path is the primary page and must work while the laptop is asleep or offline. The Codex chat gathers read-only evidence and suggests actions; it never acknowledges an alert, deploys, restarts a service, changes data or sends messages. A missing Codex wake does not suppress IRM escalation.

Configure a Justup-only IRM integration and escalation chain. Attach the `severity:critical` label to every group that should wake Codex; the watcher queries that exact label and integration. For critical groups, notify Viktor with *Important* mobile push immediately, wait five minutes, then notify again if unacknowledged. Add a second human responder only when one is actually available. In the Grafana mobile app, enable Important mobile push and send a test push. Test acknowledgement and escalation with a disposable Justup alert group before relying on it. Grafana documents the [mobile push prerequisites](https://grafana.com/docs/grafana-cloud/platform/mobile-app/push-notifications/), [escalation steps](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/escalation-and-routing/escalation-chains/) and [IRM setup](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/get-started/).

## Initial signals to qualify

These are proposed starting thresholds, not active rules. Measure the actual preview baseline and choose final numbers before activation. A missing signal is a release gap, not a zero value.

| Signal | Initial trigger | Evidence needed |
| --- | --- | --- |
| Public page and same-origin API | Two failed checks from two probe locations at five-minute frequency | Valid TLS, expected body/status, no cache and deployed browser result. |
| API and database/write readiness | Two failed `/api/v1/health` checks | Separate top-level API readiness from runner readiness; use non-mutating probes. |
| Runner heartbeat and model capability | Last verified heartbeat older than 120 seconds; model unavailable for five minutes | Expose actual readiness metrics; distinguish runner outage from total API outage. |
| Fresh job feed | Last verified import older than twice the approved refresh interval | Apply only after the feed schedule exists; preserve import-generation identity. |
| Foreground queue | Oldest admitted interactive task older than five minutes | Qualify against representative latency; no private payloads in metrics. |
| Preview storage | Free space below 128 MiB or resource guard stops a unit | The existing hard guard floor is 64 MiB; do not raise caps to clear an alert. |
| Backups | No usable backup within 36 hours for a reviewed daily cadence | Apply after #143 activates a schedule; alert on integrity/deletion-barrier failure. |
| Tunnel and alert pipeline | Tunnel unavailable for two minutes; expected telemetry absent for ten minutes | Prove notification delivery with a real test page. |

Start with one public-route and one non-mutating API check, each from two locations every five minutes. This projects `2 endpoints × 2 locations × 12 runs/hour × 24 hours × 30 days = 34,560` executions per 30-day month. Check the account's *current* allowance and Jobseek usage before enabling them; adjust scope if headroom is insufficient. Any paid overflow requires a separate approved resource request. Grafana's [HTTP check documentation](https://grafana.com/docs/grafana-cloud/observe-and-act/testing/synthetic-monitoring/create-checks/checks/http/) defines frequency, locations and status/body validation. Keep the Justup integration and rules separate from Jobseek's disabled paging route.

After the first two checks are qualified and headroom is confirmed, add a non-mutating `GET /api/v1/jobs` read-path check if needed to separate a functioning health endpoint from a broken customer job list. Do not create synthetic searches that enqueue work or spend model allowance.

## Collect private host signals

Use the exact observability-capable artifact and reviewed installed operator
scripts. From the protected root environment on the reviewed preview host,
run one bounded sample in the existing slice and save the JSON privately.

```sh
umask 077
systemd-run --quiet --wait --pipe --collect --slice=justup-preview.slice \
  --property=RuntimeMaxSec=90s --property=TimeoutStopSec=5s \
  --property=ReadOnlyPaths=/srv/justup_preview/state \
  /usr/bin/python3 -I -B /srv/justup_preview/ops/preview-host.py observe \
  --build-identity "$JUSTUP_PREVIEW_BUILD_ID" \
  --reviewed-plan-sha "$JUSTUP_REVIEWED_PLAN_SHA" \
  --host-machine-sha "$JUSTUP_PREVIEW_MACHINE_SHA" > "$JUSTUP_OBSERVATION_REPORT"
```

The report binds the sample to the active source, build and installed plan. It
records fixed API, runner, tunnel, resource guard and timer states. The resource
check runs without log cleanup or service stops. Free space is reported only for the
verified preview mount. The backup check verifies the retained set and live
deletion generation under the dedicated API user, then reports the latest usable
age and snapshot count. Application and backup probes require a verified mount
and a read-only view of the state directory.

The aggregate application read runs as the dedicated API user. It reports
whether the current SQLite schema is readable, feed verification age and import generation, foreground
queue age and the same-build runner heartbeat with capability flags. A stale
private feed reports the age of the last full snapshot. A late heartbeat retains
its age while capabilities close. Missing or invalid evidence is `null`, and an
observed empty queue reports zero with no oldest age. The readout contains no
request, account, job body, provider, or backup pathname data.

The read-only mount blocks new SQLite sidecars. A stopped application without
the live database's WAL coordination files can report an unavailable database.
The backup check reads completed, digest-verified snapshots as immutable files.

Compare the report with the same-origin HTTP probes and verified database write
readiness. An active service unit alone cannot establish these. Qualify sample
time and backup-check overhead on the target before scheduling collection, then
exercise data delivery, missing samples and phone paging under the approved
Grafana route. This command is the manual host input to that process.

## Mac watcher

`scripts/justup-incident-watch.py` is a one-shot watcher intended for a 120-second LaunchAgent interval. It uses a service account token with only `grafana-irm-app.alert-groups:read`, reads the [IRM alert-group list API](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/reference/oncall-api/alertgroups/) with the exact Justup integration ID and `severity:critical` filter, and accepts only `new` or `acknowledged` groups. It never sends alert titles, payloads, logs or credentials to Codex. It sends one fixed prompt with a validated group ID to a dedicated chat.

The watcher stores a private SQLite claim *before* calling `codex queue --resume`. This prevents automatic duplicate turns after an uncertain queue result. A `claimed` row without `queued_at` needs operator review of the chat before manual recovery; do not delete it just to retry. The script queues at most one group per run, rejects more than three IRM pages per state and stops at 10,000 retained delivery IDs. It makes GET requests only and refuses redirects. A successful queue command, even without a warning, does not prove the desktop chat consumed the turn; verify that separately in a disposable chat before relying on wakeups. The local CLI is now 0.166.0; its `queue --help` supports `--resume`. Official [Codex command documentation](https://learn.chatgpt.com/docs/developer-commands) describes `queue --thread --message`.

The following prepares the operator's Mac after the Justup IRM route exists. The config contains no token. Its directory and file must be owned by the logged-in user and private. Use the exact IRM API endpoint shown under **IRM → Settings → Admin & API** and a dedicated read-only service account token; do not use an admin or Jobseek credential.

```sh
mkdir -p "$HOME/Library/Application Support/Justup" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/Library/Application Support/Justup"
install -m 700 scripts/justup-incident-watch.py "$HOME/Library/Application Support/Justup/incident-watch.py"
```

Write `~/Library/Application Support/Justup/incident-watch.json` with mode `0600` and these exact fields, replacing the examples with reviewed values:

```json
{
  "api_url": "https://oncall-prod-region.grafana.net",
  "stack_url": "https://your-stack.grafana.net",
  "integration_id": "CJUSTUPONLY123",
  "thread_id": "00000000-0000-0000-0000-000000000000",
  "codex_bin": "/opt/homebrew/bin/codex"
}
```

Add the read-only token to macOS Keychain interactively. The final `-w` prompts for the value so it does not appear in the shell command line:

```sh
security add-generic-password -a justup-incident-watch -s justup-irm-alert-groups-readonly -w
```

Restart the Codex desktop app after the CLI upgrade, verify `codex queue --help` on this laptop, and test `--resume` with a disposable idle Codex chat. Confirm the turn actually appears and completes. Configure the dedicated Justup incident chat with read-only permissions and verify them during the test; the fixed prompt alone is not a sandbox. Use that chat's UUID in the live config. After the config and Keychain item exist, run the installed watcher once with `--config "$HOME/Library/Application Support/Justup/incident-watch.json" once`. An empty poll proves only the credential and API read; an active disposable Justup critical group is needed to prove the Codex wake. Once the phone page and watcher are both proven, generate and review the LaunchAgent from the installed script, then bootstrap it:

```sh
"$HOME/Library/Application Support/Justup/incident-watch.py" \
  --config "$HOME/Library/Application Support/Justup/incident-watch.json" \
  launchagent > "$HOME/Library/LaunchAgents/com.colophon.justup-incident-watch.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.colophon.justup-incident-watch.plist"
```

The LaunchAgent runs at login and every 120 seconds while the Mac is awake. A wake after sleep polls currently active groups and does not replay claimed IDs. To stop it, run `launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.colophon.justup-incident-watch.plist"`. Keep the config, token and delivery database out of the repository. If a queue result is uncertain, inspect the dedicated chat and private database before any manual retry:

```sh
sqlite3 "$HOME/Library/Application Support/Justup/incident-watch-state/deliveries.sqlite3" \
  "SELECT id, status, first_seen, queued_at FROM deliveries WHERE status = 'claimed';"
```

A full rehearsal records Grafana trigger time, phone delivery and acknowledgement, watcher poll, Codex turn completion and recovery notice.

## Remaining activation evidence

The backend does not yet export every metric above, and the public preview route is inactive. #141 stays open until the exact deployed service produces the required signals, Justup-only rules and phone escalation are tested, the disposable chat wake test passes, and a real failure/recovery rehearsal records observed times. #142 owns process crash drills and #143 owns backup scheduling/restore; their alerts do not prove those recovery paths work.
