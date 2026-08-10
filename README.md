# <img src="src/lib/assets/res/svg/logo.svg" alt="Sable" width="32" height="32"> Sable Next

A from-scratch rewrite of [Sable](https://github.com/SableClient/Sable), with Svelte and Rust.

Join the Matrix space at [#sable:sable.moe](https://matrix.to/#/#sable:sable.moe) to discuss the project and meowing.

## Getting started

[mise](https://mise.jdx.dev) manages Node, pnpm, Rust, and other tooling.

```bash
mise install
mise run setup    # pnpm install + git pre-commit hook
mise run dev      # SvelteKit on http://localhost:3000
```

Run `mise tasks` for the full list.

## Apps (Tauri)

Native builds use [Tauri](https://v2.tauri.app). Targets: **Windows**, **macOS**, **Linux**, **Android**, and **iOS**.

```bash
mise run tauri:setup          # Shared Rust/system dependencies, including Linux packages
mise run tauri:icons          # Regenerate native icons after changing the logo SVG
mise run tauri dev            # Run the app for the current desktop OS
mise run tauri:setup:windows  # Windows: Visual Studio Build Tools + WebView2
mise run tauri:setup:macos    # macOS: Xcode
mise run tauri:setup:android  # Android: SDK packages + NDK
mise run tauri:setup:ios      # iOS: Xcode project + CocoaPods (macOS)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0-only](LICENSE), with an [additional permission](LICENSE) for App Store executables under MPL 2.0. The Sable name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).
