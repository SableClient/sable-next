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
pnpm check        # svelte-check and TypeScript
pnpm lint         # oxlint and eslint
pnpm stylelint    # CSS rules and theme-token usage
pnpm fmt:check
pnpm knip         # unused files and exports
pnpm check:locales # unused English translation candidates
```

Stylelint checks token usage in components and custom-property references in `src/styles.css`. Vitest checks CSS and JavaScript breakpoint consistency.

Locale analysis uses `i18next-cli` and its Svelte plugin through `i18next.config.ts`. The optional check exits nonzero when it finds candidates. Dynamic key families are preserved, but indirect label references can still be flagged; review candidates before deleting them. Run `pnpm exec i18next-cli status en --hide-translated` to check for missing English keys.

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

`mise run check` runs the whole set. `sable-core` does not build at `opt-level = 0`, so the workspace profiles already raise it. The wasm tests run in a SharedWorker inside Chrome and need `chromedriver`.

The `rust-quality` workflow runs the same commands, with `cargo deny check` and `cargo fmt --check`.

## Server mode

With the Python `cryptography` package installed, run the server OIDC login against a local mock provider:

```sh
cargo build -p sable-server
SABLE_TEST_BIN="$PWD/target/debug/sable-server" python3 crates/sable-server/tests/oidc_e2e.py
```

To check that a previously released server still opens the stores after an upgrade and rollback, build the current server and frontend, then run the browser test with the previous binary:

```sh
SABLE_TEST_PREVIOUS_SERVER_BIN=/path/to/previous/sable-server \
  pnpm exec playwright test -c tests/e2e/playwright.ws-server.config.ts \
  -g 'separate server users keep Matrix accounts and media isolated'
```

The test uses temporary data and a local test homeserver.
