# Secrets and contributor setup

Doppler holds secret values. Git tracks project names, configuration selection and instructions only. The Justup prototype is static and needs no application secrets. The checked-in `doppler.yaml` preselects `justup-runtime/dev` for `doppler setup` and contains no token.

## Current stores

| Project | Current use | Configurations |
| --- | --- | --- |
| `justup-runtime` | Scoped database, authentication, email and model credentials for Justup services | `dev`, `stg`, `prd`; personal development configurations may exist |
| `justup-deploy` | Release, registry and hosting credentials | `dev`, `stg`, `prd`; separate `legacy_jobseek_*` configurations |
| `justup-admin` | Provider management, database ownership, infrastructure and recovery access | `admin`; isolated `legacy_jobseek_*`, `hosts_jobseek_*` and `quarantine` configurations |
| `justup-dormant` | Credentials held outside active consumers | `dormant`, `dormant_jobseek_*` |
| `jobseek-runtime` | Jobseek crawler and worker runtime | Per-service `prd_*`, `legacy_crawler` |
| `jobseek-web-runtime` | Jobseek web runtime | Vercel `dev_*`, `stg_*`, `prd_*`, `legacy_web` |
| `jobseek-ci-runtime` | Jobseek crawler, web support, observability, canary and TLS automation | Service-specific production configurations |

Each service and environment uses its own configuration. Legacy and dormant configurations are not Justup development defaults or active runtime sources. `quarantine` is non-operational: never load, sync or reuse its credentials; revoke or rotate the underlying provider credentials. Do not add cross-project references from runtime or deployment configurations into administration or dormant storage.

Jobseek production consumers retain their original protected configuration. A value present in Doppler does not authorize a consumer cutover or establish that the provider credential is valid. Follow the service's deployment and recovery runbook before changing a consumer; the crawler's deployment gates continue to apply.

## Local setup

Install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), then run from the repository root:

```sh
doppler login --scope .
doppler setup
```

Check the selected project and configuration before running a command. A local `.env.local` can contain production access; never copy it into this repository or treat it as a development fixture. The static prototype needs no `doppler run` command.

For a service that uses Doppler, pass the explicit project/configuration and an allowlist of only the required keys. Use `--no-fallback` unless the service intentionally uses Doppler's encrypted fallback cache. Revoking a Doppler token does not erase cached provider credentials; rotate the provider credential if a cache may remain. On macOS, the CLI stores login credentials in the system Keychain.

Never inject secret values into a frontend bundle, browser, `NEXT_PUBLIC_*` or `VITE_*` variables. Public configuration is distinct from a credential.

## Access and operation

Use a separate read-only service token for each consumer and configuration. Keep the token in that consumer's protected secret settings, never in Git, chat, command arguments or shared shell profiles. A server receives runtime access; a deployment job receives deployment access. No routine process should receive administration, dormant or quarantine access.

Root SSH keys, database-owner credentials, provider management tokens and certificate signing keys belong in administration. Routine deployment uses a dedicated restricted identity. Do not run coding agents with an administrator configuration injected into their environment.

The current Doppler plan does not provide per-person project/environment permissions. Owners and admins, including an agent using their CLI login, can access all projects. Give contributors only the development access they need; do not grant owner/admin access as a shortcut.

Third-party syncs require an explicit service/environment allowlist. Review destination keys before enabling a sync so it cannot replace production settings unexpectedly.

## References

- [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)
- [Project permissions](https://docs.doppler.com/docs/project-permissions)
- [CLI scopes and service-token precedence](https://docs.doppler.com/docs/secrets-setup-guide)
- [macOS Keychain integration](https://docs.doppler.com/docs/multiple-workplaces)
