# Testing guide

Sable has three layers of tests: the frontend (Vitest), the browser flows (Playwright), and the Rust workspace.

## Frontend

```sh
pnpm test            # Vitest, one run
pnpm test:coverage   # with a V8 coverage report in coverage/
```

Component tests use Testing Library with happy-dom. The core is mocked in `src/lib/core/__mocks__/context.ts`, which every component test shares.

## Static checks

```sh
pnpm check       # theme-token, timeline-scroll, overlay-layer and date-input guards, svelte-check, tsc
pnpm lint        # oxlint and eslint
pnpm stylelint
pnpm fmt:check
pnpm knip        # unused files and exports
```

## Accessibility

Browser component tests (`*.browser.test.ts`) can use `src/lib/test-support/a11y.ts` and `keyboard.ts`:

- `expectNoA11yViolations(element)` runs axe-core (WCAG 2.2 AA and best practices) on a rendered component.
- `expectSingleTabStop(widget)` asserts a toolbar, tablist, tree or listbox is one tab stop.
- `tabStops(root)` lists what Tab reaches inside `root`.

`tests/e2e/a11y.spec.ts` runs axe over whole pages. Storybook fails stories on axe violations.

## End to end

```sh
pnpm test:e2e        # Playwright against a fake core, no homeserver needed
pnpm test:timeline   # the timeline scenarios, with their own config
```

The e2e specs talk to `tests/e2e/fake-core.ts`, which answers commands from scripts. A new RPC method that a route calls on mount needs an entry in its `rpcHandlers`, keyed by the wire name (`'rooms.open'`). Run the specs from a clean worktree: a `pnpm` command that reinstalls mid-run breaks the Playwright teardown.

## Rust

```sh
cargo nextest run --locked --workspace --exclude app --all-features
cargo nextest run --locked -p app
cargo clippy --locked --workspace --exclude app --all-targets --all-features -- -D warnings
cargo clippy --locked -p sable-wasm --target wasm32-unknown-unknown --all-targets --all-features -- -D warnings
cargo test --locked -p sable-wasm --target wasm32-unknown-unknown --profile wasm-test
```

`sable-runtime` and `sable-ffi` have their own harness and stress tests: see [the runtime](runtime-v2.md#testing).

`mise run check` runs the whole set. `sable-core` does not build at `opt-level = 0`, so the workspace profiles already raise it. The wasm tests run in a SharedWorker inside Chrome and need `chromedriver`.

The `rust-quality` workflow runs the same commands, with `cargo deny check` and `cargo fmt --check`.
