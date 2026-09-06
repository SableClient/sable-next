# Contributing to Sable Next

Before opening a pull request, run:

```bash
mise run ci
pnpm test:e2e
```

Include tests for changed behavior. Keep pull requests focused and explain any changes that affect storage, authentication, or native capabilities.

After changing `crates/sable-core/src/protocol.rs`, run `mise run generate:types`
and commit `src/generated/protocol.ts`. `mise run check:types` checks for drift.
Both commands enable the optional `sable-core/typegen` feature for Specta.
