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

Release APKs built without `keystore.properties` are unsigned. Sign them before
installation.

### Release checksums

Keep the primary key offline. CI only gets a signing subkey.

```bash
gpg --batch --passphrase '' --quick-generate-key \
  'Sable Releases <releases@sable.moe>' ed25519 cert never
primary=$(gpg --list-keys --with-colons 'Sable Releases' | awk -F: '/^fpr/ {print $10; exit}')
gpg --batch --passphrase '' --quick-add-key "$primary" ed25519 sign 1y
gpg --armor --export "$primary" > docs/release-signing-key.asc

# RELEASE_GPG_KEY_ID: the newest signing subkey
subkey=$(gpg --list-keys --with-colons "$primary" \
  | awk -F: '/^sub/ {s=1; next} s && /^fpr/ {f=$10; s=0} END {print f}')
# RELEASE_GPG_KEY
gpg --armor --export-secret-subkeys "$subkey!"
```

To rotate, add a new subkey, update both secrets and re-export
`docs/release-signing-key.asc`.

```bash
# Verify a download
gpg --import release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```
