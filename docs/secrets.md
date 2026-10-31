# Secrets and contributor setup

Doppler holds secret values. Git holds project names, configuration, and instructions only. The static Justup prototype needs no application secrets.

## Stores

| Project | Purpose | Configurations |
| --- | --- | --- |
| `justup-runtime` | Justup server runtime: scoped database, authentication, email and model API credentials | `dev`, `stg`, `prd`; personal development branches may exist |
| `justup-deploy` | Deployment automation: release, registry and hosting tokens | `dev`, `stg`, `prd`; `legacy_jobseek_*` contains imported Jobseek deployment credentials |
| `justup-admin` | Provider management, database ownership, broad infrastructure access and recovery credentials | `admin`; Jobseek imports use `legacy_jobseek_*` and `hosts_jobseek_*`; `quarantine` is isolated |
| `justup-dormant` | Unused or historical credentials requiring review before reuse | `dormant`; imported Jobseek material uses `dormant_jobseek_*` |
| `jobseek-runtime` | Existing Jobseek crawler and worker credentials, kept separate from Justup defaults | Per-service `prd_*`; `legacy_crawler` preserves the local snapshot |
| `jobseek-web-runtime` | Existing Jobseek web credentials | Vercel `dev_*`, `stg_*`, `prd_*`; `legacy_web` preserves the local snapshot |

The `legacy` environment is an import boundary, not a development environment. A file named `.env.local` can contain production access. Do not promote these credentials into Justup defaults or assume they are safe for contributors.

Each service and environment gets its own configuration. Vercel development, preview and production map to `dev`, `stg` and `prd`, respectively. Credentials for the existing web service, crawler, observability and other workers remain separate. Importing a broad credential does not narrow its provider permissions; replace broad credentials with scoped ones before granting access to a consumer.

Root SSH keys, database-owner credentials, provider management tokens and certificate signing keys belong in administration, even if an old deployment used them. Normal deployments should use a dedicated restricted deployment identity.

`justup-admin/quarantine` is reserved for possibly exposed credentials preserved during the requested migration for incident review. These are **not reusable dormant secrets**. Revoke or rotate them at the provider; do not inject them into any process or sync them to another service. No persistent machine tokens or integrations should target administration, quarantine or dormant configurations.

## Local setup

Install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), then run from the repository root:

```sh
doppler login --scope .
doppler setup
```

The checked-in `doppler.yaml` selects `justup-runtime/dev`. It contains no token or secret values. On macOS the CLI uses the system Keychain for login credentials.

For a future server process, inject only the keys it needs:

```sh
doppler run --project justup-runtime --config dev --no-fallback \
  --only-secrets DATABASE_URL,RESEND_API_KEY -- your-server-command
```

Replace the example allowlist and command with that service's actual requirements. Never inject secrets into a frontend bundle, a browser, `NEXT_PUBLIC_*`, or `VITE_*` variables. Public configuration is distinct from a credential.

`--no-fallback` disables reading and writing the local fallback cache. If a consumer intentionally uses Doppler's encrypted fallback feature, revoking its Doppler token does not erase cached provider credentials. Rotate the underlying provider credential when necessary.

## Deployment and contributor access on the current plan

Use a separate **read-only service token for one configuration and one consumer**. Store that bootstrap token in the destination service's protected secret settings. Do not put it in repository files, command arguments, chat, or shared shell profiles. Prefer expiration and revoke tokens when a contributor or consumer no longer needs access.

A server receives a runtime token; a deployment job receives a deployment token. Avoid a single job that receives all four stores. Doppler service tokens are bound to their configuration. Pass the matching project/config explicitly in automation: a conflicting local setup can cause a request to fail. Changing flags does not turn a development token into a production token.

The current plan supports this machine-access separation. **Per-person project/environment permissions require Team or Enterprise.** Owners and admins can read all projects. Keeping credentials in separate projects does not restrict the workspace owner or a coding agent with access to that owner's CLI login. Do not invite contributors with owner/admin access as a workaround; give a contributor only the specific development access they need, or upgrade deliberately if human role controls become necessary. No subscription upgrade is part of this setup.

Do not add cross-project secret references from runtime/deployment to administration or dormant storage. Those references would defeat the intended separation. Do not run coding agents with an administrator configuration injected into their environment.

## Import and migration contract

The migration reads existing Jobseek local environment files and service-owned host credential files, plus Vercel values that the provider explicitly returns decrypted. It copies values into Doppler and compares them against a fresh read in memory. It does not print values, write plaintext exports, restart services, change live credentials, or delete source files.

Distinct historical values are retained as numbered variants in dormant storage, with source metadata in a private migration report outside Git. Historical does not mean valid: review ownership, scope, expiration and current provider status before any reuse. Possibly exposed OpenAI material is quarantined separately and still requires provider-side revocation.

Vercel list responses can contain ciphertext. Only values confirmed decrypted may be imported. Vercel sensitive variables and GitHub Actions secrets are write-only through their APIs; names are inventory, not proof that the values were migrated. GitHub's documented import route uses a reviewed, owner-dispatched Actions workflow that transfers an explicit allowlist directly into a temporary Doppler inbox, verifies it, and then revokes its short-lived bootstrap token. Preserve the source environment's existing protections and classify the verified inbox values afterward. Recover other originals or rotate them through the supported provider workflow; do not add an application endpoint to extract protected production secrets.

The current plan limits each environment to 10 configurations. Keeping web and crawler runtime projects separate, and dividing administration into `admin`, `legacy`, `hosts` and `quarantine`, stays within that limit. Doppler's default Classic naming also requires uppercase key names: imported names such as `CRAWLER_BROWSER_IPv4` become `CRAWLER_BROWSER_IPV4`. The private report records each original name; a future consumer cutover must explicitly preserve or adapt those aliases.

Existing production consumers continue using their original protected configuration until an explicit, verified cutover. Do not delete local/host originals while they are still needed by those consumers. Back up recovery material, establish a per-service allowlist, replace the consumer's secret-loading path, verify health through its deployment runbook, and only then remove obsolete copies. The crawler's deployment gates and operational contract continue to apply.

Third-party syncs must target an explicit service/environment allowlist. Review existing destination keys before enabling a sync, to avoid replacing production settings. No live sync is implied by creating these stores.

## References

- [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)
- [Project permissions and plan requirements](https://docs.doppler.com/docs/project-permissions)
- [Setting and importing secrets](https://docs.doppler.com/docs/setting-secrets)
- [CLI scopes and service-token precedence](https://docs.doppler.com/docs/secrets-setup-guide)
- [macOS Keychain integration](https://docs.doppler.com/docs/multiple-workplaces)
