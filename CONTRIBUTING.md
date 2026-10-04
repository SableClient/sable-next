# Contributing to Sable v2

Everyone taking part in Sable v2 follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

Before opening a pull request, run:

```bash
mise run ci
pnpm test:e2e
```

Include tests for changed behavior. Keep pull requests focused and explain any changes that affect storage, authentication, or native capabilities.

After changing `crates/sable-core/src/protocol.rs`, run `mise run generate:types`
and commit `src/generated/protocol.ts`. `mise run check:types` checks for drift.
Both commands enable the optional `sable-core/typegen` feature for Specta.

## Certificate of origin

Every commit needs a `Signed-off-by` trailer matching its author, certifying
the [`DCO`](DCO):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it from your `user.name` and `user.email`. Sign off under
the name you go by; a pseudonym you use consistently is fine. The `DCO` check
names any commit missing it: `git commit -s --amend --no-edit` fixes the last
one, `git rebase --signoff origin/main` a whole branch. Force-push with
`--force-with-lease`.

## AI-generated content

**Sable v2 declines any contribution believed to include or derive from
AI-generated content, including ChatGPT, Claude, Copilot, Llama and similar
tools.**

Signing off means you understand the copyright and license status of what you
submit. For AI-generated output that status is ill-defined: training material is
often under restrictive terms, and open source terms are not all AGPL-3.0
compatible.

Raise exceptions in [#sable:sable.moe](https://matrix.to/#/#sable:sable.moe)
before writing code. An exception keeps the sign-off: you stay responsible for
every line you submit, whatever produced it.

## Release notes and versioning (Knope)

We use [Knope](https://knope.tech/) to turn change files into the changelog and the release. Its configuration is [`knope.toml`](./knope.toml), and it talks to Forgejo through the `[gitea]` section.

### Documenting a change

A change file is a Markdown file in `.changeset/` holding the semver bump and a user-facing summary. For any user-facing pull request, add one before requesting review:

- `pnpm run document-change` opens an interactive prompt, or
- create `.changeset/<descriptive-name>.md` by hand:

```md
---
default: patch
---

Short user-facing summary of the change.
```

Use `major`, `minor`, `patch`, `docs` or `note`. The `internal` label skips the check for maintenance work with no user-facing impact.

### Release flow

- Every push to `main` runs `prepare-release`, which keeps a `release` pull request up to date: it bumps `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`, writes `CHANGELOG.md`, the Android changelogs under `fastlane/` and the Flatpak metainfo release entry.
- Merging that pull request runs `knope release`, which tags `vX.Y.Z` and creates the release. The tag starts the build.
- Both workflows need a `RELEASE_TOKEN` secret: a personal access token that can write contents and pull requests. The run token cannot start the tag build.
- After a release the build workflow publishes to the package repositories. Each step skips itself when its secret is unset: `AUR_KEY` (an SSH key for `sable-bin`, and `sable-nightly-bin` on nightlies), `HOMEBREW_TAP_TOKEN` (a token for `SableClient/homebrew-sable` on Forgejo, installed with `brew tap SableClient/sable https://git.sable.moe/SableClient/homebrew-sable.git`) and `FLATHUB_TOKEN` (opens the update PR on `flathub/moe.sable.client`, which must exist first).
- Preview a release with `pnpm run knope -- release --dry-run`, and validate the config with `pnpm run knope -- --validate`.
