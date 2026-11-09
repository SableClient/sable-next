# Self-hosted web client

The web client runs in the browser and connects directly to a Matrix homeserver.
For a deployment that keeps Matrix stores on the server, see [server mode](server.md).

## Docker

Run the published image:

```sh
docker run -d --name sable --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  git.sable.moe/sableclient/sable-next:latest
```

The image listens on port 8080. Put an HTTPS reverse proxy in front of it. The
`dev` tag contains the nightly build.

To build the image locally, install the project tools as described in the
[README](../README.md), then run:

```sh
pnpm install
pnpm build
docker build -f packaging/docker/Dockerfile -t sable-web .
```

## Configuration

The web client fetches `config.json` at runtime. Copy [the default file](../static/config.json),
edit it, and mount it read-only at `/app/config.json` in the container:

```yaml
services:
  sable:
    image: git.sable.moe/sableclient/sable-next:latest
    ports:
      - '127.0.0.1:8080:8080'
    volumes:
      - ./config.json:/app/config.json:ro
    restart: unless-stopped
```

The web image does not translate environment variables into client settings.
The configuration is public to browsers, so do not put secrets in it. Reload
the page after changing it.

This example shows the supported fields. Omit the ones you do not need.
[`config.schema.json`](../static/config.schema.json) describes the same fields
for editors that validate JSON. The image serves it next to `config.json`, and
the shipped file refers to it with `"$schema": "./config.schema.json"`.

```json
{
  "homeserverList": ["matrix.example.org", "matrix.org"],
  "defaultHomeserver": 0,
  "allowCustomHomeservers": true,
  "featuredCommunities": {
    "servers": ["matrix.example.org"]
  },
  "pushNotificationDetails": {
    "pushNotifyUrl": "https://push.example.org/_matrix/push/v1/notify",
    "vapidPublicKey": "your-public-vapid-key",
    "webPushAppID": "your.web.app.id",
    "nativePushAppID": "your.android.app.id",
    "iosPushAppID": "your.ios.app.id",
    "unifiedPushGatewayUrl": "https://push.example.org/_matrix/push/v1/notify",
    "unifiedPushEmbeddedServerUrl": "https://push.example.org"
  },
  "embeds": {
    "serviceUrl": "https://embeds.example.org"
  },
  "supporterAwards": {
    "serviceUrl": "https://awards.example.org",
    "keys": {
      "1": "your-43-character-ed25519-public-key"
    }
  },
  "gifs": {
    "provider": "tenor",
    "proxyUrl": "gifs.example.org",
    "klipyApiKey": "your-klipy-key",
    "tenorApiKey": "your-tenor-key",
    "giphyApiKey": "your-giphy-key"
  },
  "calls": {
    "livekitServiceUrl": "https://livekit.example.org"
  },
  "searchSharing": {
    "stunServers": ["stun:stun.example.org:3478"]
  },
  "disableAccountSwitcher": false,
  "hideUsernamePasswordFields": false,
  "settingsDefaults": {
    "theme": "system",
    "urlPreviews": false,
    "hour24Clock": false
  }
}
```

- `homeserverList` supplies the login choices. Empty or missing lists use the
  built-in list. `defaultHomeserver` is a zero-based index into that list;
  `null` leaves the default empty. `allowCustomHomeservers` defaults to `true`.
- `featuredCommunities.servers` lists homeservers for room discovery; it defaults
  to an empty list.
- `pushNotificationDetails` requires all three of `pushNotifyUrl`,
  `vapidPublicKey` and `webPushAppID`. Without them, the push configuration is
  ignored. The other fields are optional and configure native or UnifiedPush
  clients. See the [Sygnal guide](sygnal-setup.md).
- `embeds.serviceUrl` enables the embed service when it is an HTTP(S) URL.
- `supporterAwards` requires an HTTP(S) service URL and at least one 43-character
  unpadded base64 or base64url Ed25519 public key, indexed by key ID.
- `gifs.provider` accepts `klipy`, `tenor` or `giphy`, defaulting to `tenor`.
  GIF search also needs `proxyUrl` (a Matrix server name, without a scheme) and
  the API key for the selected provider.
- `calls.livekitServiceUrl` provides a fallback LiveKit service URL.
- `searchSharing.stunServers` lists the STUN servers used to share search history between
  devices. It defaults to `stun:stun.sable.moe:3478`. An empty list keeps transfers on the
  local network.
- `disableAccountSwitcher` and `hideUsernamePasswordFields` default to `false`.
- `settingsDefaults` sets initial client preferences. Existing user choices take
  precedence. The [settings reference](settings.md) lists every accepted name,
  value and default. Invalid values are ignored or, for numeric ranges, clamped.

The shipped `config.json` includes Sable's service endpoints. Remove or replace
them if you do not intend to use them.

### Branding and organisation policy

These fields rebrand the web client and enforce policy for an organisation.
Omit any of them to keep Sable's behaviour.

```json
{
  "branding": {
    "appName": "Acme Chat",
    "logoUrl": "/branding/logo.svg",
    "faviconUrl": "/branding/favicon.png",
    "themeUrl": "/branding/theme.css"
  },
  "links": {
    "help": "https://help.example.org",
    "privacy": "https://example.org/privacy",
    "terms": [{ "text": "Terms of use", "url": "https://example.org/terms" }],
    "supportRoom": "#help:example.org",
    "bugReport": "https://example.org/report"
  },
  "hideCommunityLinks": true,
  "auth": {
    "ssoRedirect": "immediate",
    "disableRegistration": true,
    "logoutRedirectUrl": "https://example.org",
    "deviceDisplayName": "Acme Chat web"
  },
  "settingsLocked": {
    "errorReporting": false
  }
}
```

- `branding.appName` replaces "Sable" in the interface, page titles and
  notifications. Text about the Sable project itself, such as donations and
  the default theme name, keeps the Sable name.
- `branding.logoUrl`, `faviconUrl` and `themeUrl` accept a path on the same
  site or an HTTP(S) URL. Serve the files next to `config.json`, for example by
  mounting a directory at `/app/branding`.
- `branding.themeUrl` points at a theme file in the same format users import as
  a custom theme. It is the base theme, so users' own themes and quick CSS still
  apply on top. It loads after startup, so the default theme can show briefly.
- `links.help`, `links.privacy` and `links.terms` appear in the sign-in footer.
  `links.privacy` also replaces the telemetry policy link and the `/privacy`
  page. `links.supportRoom` replaces the support room on the home page.
  `links.bugReport` replaces the Sable issue tracker in bug reports.
- `hideCommunityLinks` hides the Sable source, donation and support links,
  supporter awards, the theme catalogue and the Sable issue tracker.
- `auth.ssoRedirect` starts single sign-on without a click when the homeserver
  offers exactly one SSO or OIDC provider and no password login. `immediate`
  applies to every sign-in screen, `loginPage` only to the login screen. The
  sign-in window opens as a popup, so a browser may block it until the user
  allows popups for the site.
- `auth.disableRegistration` removes account creation from the client. The
  homeserver must also refuse registration to enforce it.
- `auth.logoutRedirectUrl` is opened after the last account signs out.
- `auth.deviceDisplayName` names new sessions in users' device lists. It
  defaults to `branding.appName`.
- `settingsLocked` uses the same names and values as `settingsDefaults`, but
  users cannot change them. Locked settings show as managed by the
  organisation, are not synced between devices, and a user's earlier choice
  returns if the lock is removed.

Encryption policy comes from the homeserver, not from `config.json`. The client
reads the `io.element.e2ee` block of `/.well-known/matrix/client`, as Element
does. `"default": false` makes new rooms and direct chats unencrypted by default,
and `"force_disable": true` creates them unencrypted and removes the option to
encrypt them. The older `im.vector.riot.e2ee` block is read when
`io.element.e2ee` is absent.

Some files are read before `config.json` loads, so rebranding them means
replacing the files themselves:

- `manifest.webmanifest`, which sets the installed app name, icons and colours.
- `icons/`, which holds the install and touch icons.
- The `theme-color` and `apple-mobile-web-app-title` tags, which colour the
  browser chrome and name the iOS home screen icon. Every prerendered HTML page
  carries them, so change them in `src/app.html` and rebuild.

Changing native launcher names and icons requires rebuilding the app.

For non-container hosting, build with `pnpm build` and serve the `dist` directory,
including `config.json`. Configure the web server to fall back to `index.html`
for client routes and avoid caching `config.json` and `index.html` indefinitely.

### Homeserver configuration

Serve account configuration at `https://<server-name>/.well-known/sable`.
Web, desktop and mobile clients use the entered homeserver during login and the
server name in the account's Matrix ID after sign-in. Matrix API delegation
does not change this location. Preserve any port in the server name and enable
CORS (`Access-Control-Allow-Origin: *`) for web clients.

Use the same format as `config.json`:

```json
{
  "branding": {
    "appName": "Acme Chat",
    "logoUrl": "/branding/logo.svg",
    "themeUrl": "/branding/theme.json"
  },
  "links": { "help": "https://help.example.org" },
  "settingsLocked": { "sendReadReceipts": false }
}
```

Supported fields: `branding`, `links`, `hideCommunityLinks`, `auth`,
`hideUsernamePasswordFields`, `settingsDefaults` and `settingsLocked`.
Relative branding URLs resolve against the configuration URL. Validate the document
with [`well-known-sable.schema.json`](../static/well-known-sable.schema.json).

Account defaults and locks accept the settings not marked deployment only in the
[settings reference](settings.md). Locking `sendReadReceipts` to `false` also hides
receipt indicators and controls.

Account branding and links override deployment values. Login options apply to
the selected homeserver. Settings use this precedence: deployment locks,
account locks, user choices, account defaults, deployment defaults, built-in
defaults. Remote values are neither saved as user preferences nor synced.

Configuration is cached per account and fetched once per domain per session,
with a five-second timeout. Failed requests and invalid documents retain the
cache; HTTP 404/410 or `{}` clears it. Missing configuration does not block
sign-in. Switching accounts replaces branding and settings; signing out of the
last account restores the deployment configuration.
