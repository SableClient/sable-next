import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bundleId = process.argv[2];
const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH } = process.env;
if (!bundleId || !APPLE_API_KEY || !APPLE_API_ISSUER || !APPLE_API_KEY_PATH) {
  console.error(
    'Usage: APPLE_API_KEY=… APPLE_API_ISSUER=… APPLE_API_KEY_PATH=… app-store-adp.mjs <bundle-id>'
  );
  process.exit(1);
}

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'ES256', kid: APPLE_API_KEY, typ: 'JWT' })}.${base64url({
    iss: APPLE_API_ISSUER,
    iat: now,
    exp: now + 600,
    aud: 'appstoreconnect-v1',
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: createPrivateKey(readFileSync(APPLE_API_KEY_PATH)),
    dsaEncoding: 'ieee-p1363',
  });
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function appStoreConnect(path, query) {
  const url = `https://api.appstoreconnect.apple.com${path}?${new URLSearchParams(query)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!response.ok)
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

const apps = await appStoreConnect('/v1/apps', { 'filter[bundleId]': bundleId });
const app = apps.data.find((candidate) => candidate.attributes.bundleId === bundleId);
if (!app) throw new Error(`No App Store Connect app has the bundle ID ${bundleId}`);

const versions = await appStoreConnect(`/v1/apps/${app.id}/appStoreVersions`, {
  'filter[platform]': 'IOS',
  'filter[appVersionState]': [
    'ACCEPTED',
    'PENDING_DEVELOPER_RELEASE',
    'PROCESSING_FOR_DISTRIBUTION',
    'READY_FOR_DISTRIBUTION',
  ].join(','),
  include: 'build,alternativeDistributionPackage',
  limit: '10',
});
const live = versions.data
  .filter((version) => version.relationships.alternativeDistributionPackage.data)
  .sort((a, b) => b.attributes.createdDate.localeCompare(a.attributes.createdDate))[0];
if (!live) {
  throw new Error(
    `${bundleId} has no approved iOS version with an alternative distribution package. Check that the app is selected for AltStore PAL in App Store Connect.`
  );
}

const buildId = live.relationships.build.data?.id;
const build = versions.included?.find((item) => item.type === 'builds' && item.id === buildId);
const adpID = live.relationships.alternativeDistributionPackage.data.id;
if (!build) throw new Error(`Version ${live.attributes.versionString} has no build`);

console.log(
  JSON.stringify({
    marketplaceID: app.id,
    version: live.attributes.versionString,
    build: build.attributes.version,
    adpID,
  })
);
