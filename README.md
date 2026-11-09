# <img src="src/lib/assets/res/svg/logo.svg" alt="Sable" width="32" height="32"> Sable

An almost stable Matrix client, written from scratch in Rust and Svelte.  
Trying to be feature-complete while enhancing the user experience with quality-of-life features, cosmetics, utilities and sheer usability.

Join the Matrix space at [#sable:sable.moe](https://matrix.to/#/#sable:sable.moe) for project & feature discussions, help with issues, and meowing.

The **web build** is deployed to [app.sable.moe](https://app.sable.moe/) and the nightly beta is at [dev.sable.moe](https://dev.sable.moe/). Read on for installation instructions.

# Installation

<a href="https://git.sable.moe/SableClient/sable-next/releases/latest"><img alt="Windows" src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge"></a>
&nbsp;
<a href="https://play.google.com/store/apps/details?id=moe.sable.client"><img alt="Google Play" src="https://img.shields.io/badge/Google_Play-3DDC84?style=for-the-badge&logo=googleplay&logoColor=white"></a>
&nbsp;
<a href="https://flathub.org/apps/moe.sable.client"><img alt="Flathub" src="https://img.shields.io/badge/Flathub-4A86CF?style=for-the-badge&logo=flathub&logoColor=white"></a>
&nbsp;
<a href="https://apt.izzysoft.de/packages/moe.sable.client"><img alt="IzzyOnDroid" src="https://img.shields.io/badge/IzzyOnDroid-1A73E8?style=for-the-badge&logo=fdroid&logoColor=white"></a>
&nbsp;
<a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22moe.sable.client%22%2C%22url%22%3A%22https%3A%2F%2Fgit.sable.moe%2FSableClient%2Fsable-next%22%2C%22author%22%3A%22SableClient%22%2C%22name%22%3A%22Sable%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22about%5C%22%3A%5C%22The%20next%20Sable%20Matrix%20client%5C%22%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android-universal%5C%5C%5C%5C.apk%24%5C%22%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%7D%22%2C%22overrideSource%22%3A%22Codeberg%22%7D"><img alt="Add to Obtainium" src="https://img.shields.io/badge/Add_to_Obtainium-6750A3?style=for-the-badge"></a>

## Android

### Google Play

<a href="https://play.google.com/store/apps/details?id=moe.sable.client"><img alt="Google Play" src="https://img.shields.io/badge/Google_Play-3DDC84?style=for-the-badge&logo=googleplay&logoColor=white"></a>

Click the button above or [this link](https://play.google.com/store/apps/details?id=moe.sable.client) to download Sable from Google Play.

### IzzyOnDroid

<a href="https://apt.izzysoft.de/packages/moe.sable.client"><img alt="IzzyOnDroid" src="https://img.shields.io/badge/IzzyOnDroid-1A73E8?style=for-the-badge&logo=fdroid&logoColor=white"></a>

Use an F-Droid client, like [Neo Store](https://github.com/NeoApplications/Neo-Store) or [Droid-ify](https://droidify.app/), to download Sable from the [IzzyOnDroid repository](https://apt.izzysoft.de/packages/moe.sable.client).

### Obtainium

APKs ship with every build, and [Obtainium](https://obtainium.imranr.dev) updates them straight from Forgejo. Each build also publishes an `obtainium.json` app config.

#### Stable

<a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22moe.sable.client%22%2C%22url%22%3A%22https%3A%2F%2Fgit.sable.moe%2FSableClient%2Fsable-next%22%2C%22author%22%3A%22SableClient%22%2C%22name%22%3A%22Sable%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22about%5C%22%3A%5C%22The%20next%20Sable%20Matrix%20client%5C%22%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android-universal%5C%5C%5C%5C.apk%24%5C%22%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%7D%22%2C%22overrideSource%22%3A%22Codeberg%22%7D"><img alt="Add to Obtainium" src="https://img.shields.io/badge/Add_to_Obtainium-6750A3?style=for-the-badge"></a>
&nbsp;
<a href="https://git.sable.moe/SableClient/sable-next/releases/download/latest/obtainium.json"><img alt="App config" src="https://img.shields.io/badge/App_config-6B7280?style=for-the-badge"></a>

```
moe.sable.client
BC:9F:83:A1:AC:9C:33:2D:F7:39:75:96:2E:78:B5:57:24:D0:6A:EE:E7:3E:FF:8B:7B:78:52:61:AD:48:62:8B
```

#### Nightly

<a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22moe.sable.next.nightly%22%2C%22url%22%3A%22https%3A%2F%2Fgit.sable.moe%2FSableClient%2Fsable-next%22%2C%22author%22%3A%22SableClient%22%2C%22name%22%3A%22Sable%20Next%20Nightly%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22about%5C%22%3A%5C%22The%20next%20Sable%20Matrix%20client%20(nightly)%5C%22%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android-universal%5C%5C%5C%5C.apk%24%5C%22%2C%5C%22includePrereleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5ENightly%20build%20%5C%22%7D%22%2C%22overrideSource%22%3A%22Codeberg%22%7D"><img alt="Add to Obtainium" src="https://img.shields.io/badge/Add_to_Obtainium-6750A3?style=for-the-badge"></a>
&nbsp;
<a href="https://git.sable.moe/SableClient/sable-next/releases/download/nightly/obtainium.json"><img alt="App config" src="https://img.shields.io/badge/App_config-6B7280?style=for-the-badge"></a>
```
moe.sable.next.nightly
BC:9F:83:A1:AC:9C:33:2D:F7:39:75:96:2E:78:B5:57:24:D0:6A:EE:E7:3E:FF:8B:7B:78:52:61:AD:48:62:8B
```

#### Setup & install

1. Install [Obtainium](https://obtainium.imranr.dev).
2. Tap **Add to Obtainium** above. Choose the nightly config if you want to receive pre-releases. Alternatively, download `obtainium.json` and import it with **Import/Export → Import from file**.
3. (Optional) Verify the download is genuine using [**AppVerifier**](https://github.com/soupslurpr/AppVerifier).

Apps added before the move to per-build prereleases have to be removed and re-added.

## Desktop

### Windows

<a href="https://git.sable.moe/SableClient/sable-next/releases/latest"><img alt="Windows" src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge"></a>

The Windows build automatically checks for updates. Download and run [the setup](https://git.sable.moe/SableClient/sable-next/releases/latest).

### Linux

#### Flatpak

<a href="https://flathub.org/apps/moe.sable.client"><img alt="Flathub" src="https://img.shields.io/badge/Flathub-4A86CF?style=for-the-badge&logo=flathub&logoColor=white"></a>

Stable builds are on [Flathub](https://flathub.org/apps/moe.sable.client). Nightly builds have their own Flatpak remote, rebuilt from `main` on every push:

```bash
flatpak remote-add --if-not-exists sable-next-nightly https://sableclient.github.io/sable-next/sable-next-nightly.flatpakrepo
flatpak install sable-next-nightly moe.sable.next.electron.Nightly
```

#### Arch Linux

<a href="https://aur.archlinux.org/packages/sable-bin"><img alt="AUR" src="https://img.shields.io/badge/AUR-1793D1?style=for-the-badge&logo=archlinux&logoColor=white"></a>

Install and update using your preferred AUR helper:

```bash
yay -S sable-bin
paru -S sable-bin
```

Use `sable-nightly-bin` for nightly builds. See the
[AUR upgrade notes](packaging/aur/README.md) when upgrading older packages.

#### Nix

```bash
nix run git+https://git.sable.moe/SableClient/sable-next#sable-desktop
```

#### Using Forgejo Repositories

Packages are published to the Forgejo repositories at `git.sable.moe`. Use `nightly` instead of `stable` for nightly builds; the package is then `sable-nightly`.

##### Debian, Ubuntu

```bash
sudo curl https://git.sable.moe/api/packages/SableClient/debian/repository.key -o /etc/apt/keyrings/forgejo-SableClient.asc
echo "deb [signed-by=/etc/apt/keyrings/forgejo-SableClient.asc] https://git.sable.moe/api/packages/SableClient/debian stable main" | sudo tee /etc/apt/sources.list.d/sable.list
sudo apt update && sudo apt install sable
```

##### Fedora, RHEL, openSUSE
```bash
sudo dnf config-manager addrepo --from-repofile=https://git.sable.moe/api/packages/SableClient/rpm/stable.repo
sudo dnf install sable
```

### MacOS (Homebrew)

<a href="https://git.sable.moe/SableClient/homebrew-sable"><img alt="Homebrew" src="https://img.shields.io/badge/Homebrew-FBB040?style=for-the-badge&logo=homebrew&logoColor=black"></a>

Install using Homebrew:

```bash
brew install --cask SableClient/sable/sable
```

The cask is published to the GitHub tap, which `brew install` taps by default, and to a Forgejo mirror: `brew tap SableClient/sable https://git.sable.moe/SableClient/homebrew-sable.git`.

## iOS

### App Store

There is a [Testflight](https://testflight.apple.com/join/PT2DSC3f) you can join while the app is under review. It will be available on the App Store soon™.

### AltStore PAL

In the EU, [AltStore PAL](https://altstore.io) installs the notarized App Store build. Open AltStore PAL, go to Sources, tap +, and paste:

<a href="https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-pal-source.json"><img alt="Direct URL" src="https://img.shields.io/badge/Direct_URL-6B7280?style=for-the-badge"></a>

`https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-pal-source.json`

The [`altstore-pal.yml`](.forgejo/workflows/altstore-pal.yml) workflow publishes each App Store release once AltStore has processed it.

### AltStore / SideStore

iOS builds are unsigned IPAs distributed through [AltStore](https://altstore.io) and [SideStore](https://sidestore.io). Each release publishes its IPA with an `altstore-source.json` that lists it.

#### Stable source

<a href="https://intradeus.github.io/http-protocol-redirector?r=altstore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-source.json"><img alt="Add to AltStore" src="https://img.shields.io/badge/Add_to_AltStore-7C3AED?style=for-the-badge"></a>
&nbsp;
<a href="https://intradeus.github.io/http-protocol-redirector?r=sidestore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-source.json"><img alt="Add to SideStore" src="https://img.shields.io/badge/Add_to_SideStore-2563EB?style=for-the-badge"></a>
&nbsp;
<a href="https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-source.json"><img alt="Direct URL" src="https://img.shields.io/badge/Direct_URL-6B7280?style=for-the-badge"></a>

#### Nightly source

<a href="https://intradeus.github.io/http-protocol-redirector?r=altstore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/nightly/altstore-source.json"><img alt="Add to AltStore" src="https://img.shields.io/badge/Add_to_AltStore-7C3AED?style=for-the-badge"></a>
&nbsp;
<a href="https://intradeus.github.io/http-protocol-redirector?r=sidestore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/nightly/altstore-source.json"><img alt="Add to SideStore" src="https://img.shields.io/badge/Add_to_SideStore-2563EB?style=for-the-badge"></a>
&nbsp;
<a href="https://git.sable.moe/SableClient/sable-next/releases/download/nightly/altstore-source.json"><img alt="Direct URL" src="https://img.shields.io/badge/Direct_URL-6B7280?style=for-the-badge"></a>

#### Setup & install

1. Set up [AltStore Classic](https://faq.altstore.io/altstore-classic/altserver) or [SideStore](https://docs.sidestore.io) on your device.
2. Tap a button above, or add the source manually (swap `latest` for `nightly` in the URL for the nightly channel):
   - AltStore: `altstore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-source.json`
   - SideStore: `sidestore://source?url=https://git.sable.moe/SableClient/sable-next/releases/download/latest/altstore-source.json`
3. Install Sable v2 from the source. AltStore/SideStore re-sign the unsigned IPA with your personal development certificate at install time, so apps refresh every 7 days on a free account.

Both configs come from the `obtainium` and `altstore` jobs in [`tauri-build.yml`](.forgejo/workflows/tauri-build.yml).

## Other Releases
<a href="https://git.sable.moe/SableClient/sable-next/releases/latest"><img alt="Latest Releases" src="https://img.shields.io/badge/Download-181717?style=for-the-badge&logo=forgejo"></a>
&nbsp;
<a href="https://git.sable.moe/SableClient/sable-next/releases/latest"><img alt="Download APK" src="https://img.shields.io/badge/Download_APK-6B7280?style=for-the-badge&logo=android&logoColor=white"></a>

If your platform is not listed or you would like to download packages directly, check the [latest releases](https://git.sable.moe/SableClient/sable-next/releases/latest).

# Getting Started with Development

> You can read more about getting started [on the developer wiki](https://git.sable.moe/SableClient/sable-next/wiki/Getting-started).

Clone the repository  
`git clone https://git.sable.moe/SableClient/sable-next.git`

Node, pnpm, Rust, and other tooling are managed by [mise](https://mise.jdx.dev). After [installing it on your system](https://mise.jdx.dev/installing-mise.html), enter the directory and run the following commands to set up the project:

```bash
mise install
mise run setup    # pnpm install + git hooks
mise run dev      # SvelteKit on http://localhost:3000
```

`mise run dev` builds the development WASM bundle first. While editing Rust in
another terminal, run `mise run wasm:watch`; Vite reloads after each regenerated
bundle. Production builds generate the optimised WASM bundle automatically.

`pnpm test:e2e` generates its WASM bundle in `src/generated/wasm-e2e/`, so it
can run while the development server is using `src/generated/wasm/`.

Run `mise tasks` for the full list.

## Building without mise

Put Node, pnpm, Rust (with the `wasm32-unknown-unknown` target) and
`wasm-bindgen-cli` (the version in `Cargo.lock`) on your `PATH`, then run
`pnpm install` and `pnpm build`.

## Self-hosting

See the [web client guide](docs/web.md) for Docker and client configuration, or
the [server mode guide](docs/server.md) to run Sable and its Matrix stores on
your server.

## Apps

Desktop builds (**Windows**, **macOS**, **Linux**) use [Electron](https://www.electronjs.org); see [`electron/README.md`](electron/README.md). **Android** and **iOS** use [Tauri](https://v2.tauri.app).

```bash
mise run tauri:setup          # Shared Rust/system dependencies, including Linux packages
mise run tauri:icons          # Regenerate native icons after changing the logo SVG
mise run tauri:setup:macos    # macOS: Xcode
mise run tauri:setup:android  # Android: SDK packages + NDK
mise run tauri:setup:ios      # iOS: Xcode project + CocoaPods (macOS)
```

Every push to `main` publishes bundles for all targets as a distinct
[nightly prerelease](https://git.sable.moe/SableClient/sable-next/releases).
Linux x86_64, macOS, Android and iOS build here; Windows and Linux aarch64
build on the GitHub mirror and attach their bundles, with attestations, to the
same release. Pushing a `v*` tag publishes a stable release the same way.

The web build ships with every release as `sable-<version>-web.tar.gz`.
Extract it into your web root to serve the app yourself; see
[`Caddyfile`](Caddyfile) for an example configuration.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

AGPL-3.0-or-later, with an additional permission for App Store executables under MPL 2.0 (See [`LICENSE`](LICENSE)). The Sable name and logo are covered by [`TRADEMARKS.md`](TRADEMARKS.md).
