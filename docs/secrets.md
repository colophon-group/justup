---
summary: Find Justup credential stores and keep runtime, deployment and administration access separate.
read_when: Setting up local development or changing how a Justup service receives credentials.
---

# Secrets and contributor setup

Doppler stores Justup credentials; Git stores configuration names and instructions only. The checked-in `doppler.yaml` selects `justup-runtime/dev` for local setup and contains no token. A credential's presence does not authorize provider use, spending or deployment. Keep account identifiers, token lifetimes and setup receipts in protected operator notes.

## Credential stores

| Project | Use |
| --- | --- |
| `justup-runtime` | Separate application consumption credentials for development, staging and production. Staging and production are not yet populated. |
| `justup-deploy` | Restricted deployment identity for the existing host. Its `dev_murmur` configuration holds the installed key; the account currently permits only a forced identity probe, not deployment. |
| `justup-admin` | Provider administration and recovery, separate from application and deployment consumers. |
| `hetzner-infrastructure` | Shared Hetzner project inventory and administration access. These project-wide tokens never belong in Justup application or deployment environments. |
| `jobseek-credential-archive` | Non-operational Jobseek snapshots. Never load them into a Justup consumer. |
| `jobseek-runtime`, `jobseek-web-runtime`, `jobseek-ci-runtime` | Existing protected Jobseek production consumers. Keep them isolated from Justup. |

A specifically approved shared provider key still needs Justup-only delivery and its own spending guard. Jobseek crawler deployment and data-safety gates remain in force.

## Local development

Install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), then run from the repository root:

```sh
doppler login --scope .
doppler setup
```

Check the selected project and configuration before each command. Pass an explicit project/configuration and an allowlist of required keys to a service. Use `--no-fallback` unless that service intentionally uses Doppler's encrypted fallback cache; revoking a token does not erase cached provider credentials. Never copy a local `.env.local` into the repository or treat it as a test fixture.

Never inject secrets into frontend bundles, browsers, `NEXT_PUBLIC_*` or `VITE_*` values. Public configuration is separate from credentials. Do not print secrets in commands, logs, chat, issues, commits or screenshots.

## Service and host access

Give each consumer a separate scoped, read-only service token for its configuration. Store it in that consumer's protected environment, not in Git, shell profiles or command arguments. The API receives runtime access; a deployment job receives deployment access. No routine process receives administration or archive access.

The shared Hetzner project contains the former Murmur host and Jobseek servers. Its Cloud API tokens apply to the whole project and offer only Read or Read & Write permissions, so they cannot serve as a host-scoped Justup deployment credential. The existing host `deploy` account has Docker and Jobseek privileges; do not use it for Justup. The separate `justup-deploy` account is password-locked and has no Docker or sudo access. Its installed SSH key currently permits only a forced read-only identity probe. The `credential-role-boundaries` issue tracks the reviewed exact-command deployment gate.

Root SSH keys, database-owner credentials, provider management tokens and signing keys belong in administration when established. Do not inject an administrator configuration into coding agents or CI. Some administration keys can act across a shared provider team; a Doppler config does not narrow the provider's own permission scope. Confirm the exact sandbox, domain, zone or project before an approved administrative call.

The current Doppler plan does not provide per-person project/environment permissions. Owners and admins, including an agent using their CLI login, can access all projects. Do not grant owner/admin access as a development shortcut. Review third-party sync destinations and exact key allowlists before enabling them. Follow the [operations guide](operations.md) before changing a live consumer or its recovery path.

## References

- [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)
- [Project permissions](https://docs.doppler.com/docs/project-permissions)
- [CLI scopes and service-token precedence](https://docs.doppler.com/docs/secrets-setup-guide)
- [Hetzner Cloud API tokens](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/)
