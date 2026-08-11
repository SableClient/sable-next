# Infrastructure

`infra/web` manages the Cloudflare Worker, immutable Worker versions, the live
development deployment, and the `next.sable.moe` custom domain.

The workflow is intentionally separate from `SableClient/sable`'s state:
`sable-next-development` must be a distinct OpenTofu state from any Sable web
deployment.

Prerequisites:

- OpenTofu `1.11.x` installed locally
- Node.js/pnpm installed locally so you can build `dist/` before Worker uploads
- A Cloudflare account with the `sable.moe` zone onboarded to Cloudflare
- A GitLab project to store the OpenTofu state
- A GitLab access token that can read and write that project's OpenTofu state

Required repository secrets:

- `TF_CLOUDFLARE_API_TOKEN`
- `TF_VAR_ACCOUNT_ID`
- `TF_VAR_ZONE_ID`
- `TF_HTTP_USERNAME`
- `TF_HTTP_PASSWORD`

Required variables in the `development` GitHub Environment:

- `TF_HTTP_ADDRESS`
- `TF_HTTP_LOCK_ADDRESS`
- `TF_HTTP_UNLOCK_ADDRESS`
- `TF_VAR_CUSTOM_DOMAIN` = `next.sable.moe`
- `TF_VAR_WORKER_NAME` = `sable-next`

The three HTTP addresses must point to the separate `sable-next-development`
state. The workflows map these values to the environment variable names used by
OpenTofu and Cloudflare.

Cloudflare API token permissions:

- `Account > Workers Scripts > Edit`
- Scope the token to the account that owns the Worker.
- Scope the token to the zone serving `next.sable.moe`.
- No Pages or DNS edit permission is required; Cloudflare creates the DNS record
  when the custom domain is attached.

GitLab access token permissions:

- `api`

Local setup:

1. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in the shared
   Cloudflare account and zone values.
2. Copy `gitlab.http.tfbackend.example` to `gitlab.http.tfbackend` and replace
   the GitLab project ID and username.
3. Run `pnpm install` from the repository root.
4. Export the GitLab token as `TF_HTTP_PASSWORD` and the Cloudflare API token as
   `CLOUDFLARE_API_TOKEN`.
5. Build the web assets before planning or applying.

Local OpenTofu flow from the repository root:

```bash
pnpm run build
tofu -chdir=infra/web init -input=false -reconfigure -backend-config="../gitlab.http.tfbackend"
tofu -chdir=infra/web validate
tofu -chdir=infra/web plan -var-file="../terraform.tfvars"
tofu -chdir=infra/web apply -var-file="../terraform.tfvars"
```

The GitHub workflows are:

- `.github/workflows/cloudflare-web.yml` plans infrastructure changes and
  applies the development state on pushes to `main`, publishing to
  `https://next.sable.moe`.
- `.github/workflows/cloudflare-web-preview.yml` uploads branch and same-repo PR
  preview versions using Cloudflare Worker preview aliases.

The Worker is configured with `single-page-application` not-found handling so
client-side routes continue to resolve to the static SvelteKit shell.
