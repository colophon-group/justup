---
summary: Current credential stores, local setup and safe service access.
read_when: Setting up local credentials or changing how a service uses them.
---

# Secrets and contributor setup

Doppler is the credential manager for this project. Git tracks project names, configuration selection and instructions, while Doppler holds secret values. The checked-in `doppler.yaml` preselects `justup-runtime/dev` for local setup and contains no token.

## Current stores

| Project | Current use | Configurations |
| --- | --- | --- |
| `justup-runtime` | Justup service credentials. `dev` currently contains the domain-scoped Resend sending key and Justup OpenAI consumption key; staging and production are not populated | `dev`, `stg`, `prd`; personal development configurations may exist |
| `justup-deploy` | `dev_murmur` holds the installed SSH key pair for a dedicated, restricted Justup account on the existing host; only a forced `id` probe is allowed | Empty `dev`, `dev_personal`, `stg`, `prd`; isolated `dev_murmur` branch |
| `justup-admin` | Justup provider administration and recovery credentials; no Justup-specific Hetzner host administrator key exists | `admin` |
| `jobseek-credential-archive` | Non-operational Jobseek snapshots, including quarantined credentials; never load into a Justup consumer | `admin`, `hosts`, `deploy`, `dormant` roots and their branches |
| `jobseek-runtime` | Jobseek crawler and worker runtime | Per-service `prd_*`, `legacy_crawler` |
| `jobseek-web-runtime` | Jobseek web runtime | Vercel `dev_*`, `stg_*`, `prd_*`, `legacy_web` |
| `jobseek-ci-runtime` | Jobseek crawler, web support, observability, canary and TLS automation | Service-specific production configurations |

Each service and environment uses its own configuration. The archive is non-operational: never load, sync or reuse its credentials, especially `admin_quarantine`; revoke or rotate the underlying provider credentials as needed. Do not add cross-project references from runtime or deployment configurations into administration or archive storage.

Jobseek production consumers retain their original protected configuration. A value present in Doppler does not authorize a consumer cutover or establish that the provider credential is valid. Follow the service's deployment and recovery runbook before changing a consumer; the crawler's deployment gates continue to apply.

## Local setup

Install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), then run from the repository root:

```sh
doppler login --scope .
doppler setup
```

Check the selected project and configuration before running a command. A local `.env.local` can contain production access; never copy it into this repository or treat it as a development fixture.

For a service that uses Doppler, pass the explicit project/configuration and an allowlist of only the required keys. Use `--no-fallback` unless the service intentionally uses Doppler's encrypted fallback cache. Revoking a Doppler token does not erase cached provider credentials; rotate the provider credential if a cache may remain. On macOS, the CLI stores login credentials in the system Keychain.

Never inject secret values into a frontend bundle, browser, `NEXT_PUBLIC_*` or `VITE_*` variables. Public configuration is distinct from a credential.

## Access and operation

Use a separate read-only service token (a scoped machine credential) for each consumer and configuration. Keep it in that consumer's protected secret settings, never in Git, chat, command arguments or shared shell profiles. A server receives runtime access; a deployment job receives deployment access. No routine process should receive administration or archive access.

Root SSH keys, database-owner credentials, provider management tokens and certificate signing keys belong in administration when established. Routine deployment must use a dedicated restricted identity. Do not run coding agents with an administrator configuration injected into their environment.

The existing Hetzner `Default` project contains the former Murmur host and Jobseek servers. [Hetzner Cloud API tokens](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/) apply to the whole project, with only Read and Read & Write permissions; a token for that project cannot be scoped to Justup's host. No Hetzner Cloud token is stored in a Justup Doppler config. Existing shared-host administrator access remains in the protected operator path and must not be injected into agents or CI. The existing host `deploy` account belongs to the Docker group and has Jobseek-specific sudo permissions; do not use it for Justup.

The separate `justup-deploy` account is password-locked, has no Docker or sudo access, and cannot read the protected Jobseek environment file. Its home and SSH key path are root-owned and non-writable by the account. `HETZNER_DEPLOY_SSH_PRIVATE_KEY` and `HETZNER_DEPLOY_SSH_PUBLIC_KEY` in `justup-deploy/dev_murmur` match the installed key (fingerprint `SHA256:JAG5beyYfR+gNTwr4su5r0nen5TjRGob3YTmlbUU5PU`). SSH currently forces `/usr/bin/id` for a read-only identity probe; it cannot deploy. The `credential-role-boundaries` issue records the live checks and tracks the reviewed exact-command release gate. Keep the key out of application runtime and CI until that gate exists; do not make the account's home or key path writable.

Some administration keys in `justup-admin/admin` can act across a shared provider team or organization. The Doppler config limits where agents obtain them; it does not narrow the provider's own permission scope. Confirm the target project, sandbox, domain or zone before an administrative API call. Keep consumption keys in `justup-runtime` and use provider APIs for administration where they offer the required scope.

The current Doppler plan does not provide per-person project/environment permissions. Owners and admins, including an agent using their CLI login, can access all projects. Give contributors only the development access they need; do not grant owner/admin access as a shortcut.

Third-party syncs require an explicit service/environment allowlist. Review destination keys before enabling a sync so it cannot replace production settings unexpectedly.

## References

- [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)
- [Project permissions](https://docs.doppler.com/docs/project-permissions)
- [CLI scopes and service-token precedence](https://docs.doppler.com/docs/secrets-setup-guide)
- [macOS Keychain integration](https://docs.doppler.com/docs/multiple-workplaces)
