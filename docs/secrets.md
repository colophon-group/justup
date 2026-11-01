---
summary: Select Justup credential stores and keep runtime, deployment and administration access separate.
read_when: Setting up local development or changing how a Justup service receives credentials.
---

# Secrets and contributor setup

Doppler stores Justup credentials; Git stores only configuration names and instructions. The checked-in `doppler.yaml` selects `justup-runtime/dev` for local setup and contains no token. A credential’s presence never authorizes provider use, spending or deployment. Keep account-specific inventories, token lifetimes and setup receipts in protected operator notes.

## Justup configurations

| Project | Current use | Configurations |
| --- | --- | --- |
| `justup-runtime` | Justup service credentials; `dev` has scoped Resend sending and OpenAI consumption keys | `dev`, `stg`, `prd`; staging and production are not populated |
| `justup-deploy` | Pending SSH identity for a dedicated non-Docker Justup host account | Empty `dev`, `dev_personal`, `stg`, `prd`; only `dev_murmur` has the pending key pair |
| `justup-admin` | Justup provider administration and recovery; no Hetzner host administrator credential yet | `admin` |
| `jobseek-credential-archive` | Non-operational Jobseek snapshots, including quarantined credentials | `admin`, `hosts`, `deploy`, `dormant` roots and their branches |
| `jobseek-runtime`, `jobseek-web-runtime`, `jobseek-ci-runtime` | Protected Jobseek production consumers | Their existing service-specific configurations |

Keep Jobseek production consumers and their protected configurations separate. A specifically approved shared provider key still needs Justup-only delivery and its own spending guard; it does not grant access to Jobseek runtime configurations. Jobseek crawler deployment and data-safety gates remain in force. Never load or sync the non-operational archive into a Justup consumer.

## Local development

Install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), then run from the repository root:

```sh
doppler login --scope .
doppler setup
```

Check the selected project and configuration before each command. Use an explicit project/configuration and an allowlist of required keys for each service. Use `--no-fallback` unless the service intentionally uses Doppler’s encrypted fallback cache; revoking a token does not erase cached provider credentials. Never copy a local `.env.local` into the repository or treat it as a test fixture.

Never inject secrets into frontend bundles, browsers, `NEXT_PUBLIC_*` or `VITE_*` values. Public configuration is separate from credentials. Do not print secrets in commands, logs, chat, issues, commits or screenshots.

## Service access

Give each consumer a separate scoped, read-only service token for its chosen configuration. Store it in that consumer’s protected environment, not in Git, shell profiles or command arguments. The API receives runtime access; a deployment job receives deployment access. No routine process receives administration or archive access.

The existing Hetzner `Default` project contains the former Murmur host and Jobseek servers. [Cloud API tokens](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/) apply to the whole project and offer only Read or Read & Write permissions, so none is stored as a Justup deployment credential. The shared host `deploy` account has Docker and Jobseek-specific sudo access; it is not a Justup deployment identity. The new public/private key pair in `justup-deploy/dev_murmur` is pending installation for a separate non-Docker account and grants no host access yet. Its public fingerprint is `SHA256:JAG5beyYfR+gNTwr4su5r0nen5TjRGob3YTmlbUU5PU`. The `credential-role-boundaries` issue tracks host installation and verification.

Root SSH keys, database-owner credentials, provider management tokens and signing keys belong in administration when established. Do not inject an administrator configuration into coding agents or CI. Some administration keys can act across a shared provider team; a Doppler config does not narrow the provider's own permissions. Confirm the exact sandbox, domain, zone or project before an approved administrative call.

The current Doppler plan does not provide per-person project/environment permissions. Owners and admins, including an agent using their CLI login, can access all projects. Do not grant owner/admin access as a development shortcut. Review third-party sync destinations and exact key allowlists before enabling them. Follow the [operations guide](operations.md) before changing a live consumer or its recovery path.

## References

- [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)
- [Project permissions](https://docs.doppler.com/docs/project-permissions)
- [CLI scopes and service-token precedence](https://docs.doppler.com/docs/secrets-setup-guide)
