## Signing secrets for releases

### Android

```bash
# ANDROID_KEY_ALIAS: e.g. "upload"
# ANDROID_KEY_PASSWORD: store and key must match

keytool -genkeypair -v \
  -keystore upload-keystore.jks \
  -alias "$ANDROID_KEY_ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$ANDROID_KEY_PASSWORD" \
  -keypass  "$ANDROID_KEY_PASSWORD" \
  -dname "CN=<app>, O=<org>, C=<country>"

# ANDROID_KEY_BASE64
base64 -w0 upload-keystore.jks > android-key-base64.txt
```

Losing `upload-keystore.jks` blocks every future update: Android identifies an
app by its signing key.

To sign a release build locally, write `src-tauri/gen/android/keystore.properties`:

```
keyAlias=<alias>
password=<password>
storeFile=<absolute path to upload-keystore.jks>
```

### Desktop auto-updater

```bash
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD may be empty
pnpm tauri signer generate -w ~/.tauri/sable-next.key
```

- `TAURI_SIGNING_PRIVATE_KEY`: contents of `~/.tauri/sable-next.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the chosen password
- `~/.tauri/sable-next.key.pub` goes in `plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json`

Losing the private key prevents publishing updates to installed apps.
