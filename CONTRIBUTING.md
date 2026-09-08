# Contributing to Sable Next

Everyone taking part in Sable Next follows the
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

**Sable Next declines any contribution believed to include or derive from
AI-generated content, including ChatGPT, Claude, Copilot, Llama and similar
tools.**

**Other uses of AI are fine — researching APIs, static analysis, debugging — as
long as their output stays out of the contribution.**

Signing off means you understand the copyright and license status of what you
submit. For AI-generated output that status is ill-defined: training material is
often under restrictive terms, and open source terms are not all AGPL-3.0
compatible.

Raise exceptions in [#sable:sable.moe](https://matrix.to/#/#sable:sable.moe)
before writing code. An exception keeps the sign-off: you stay responsible for
every line you submit, whatever produced it.
