import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const packageRoot =
  process.argv[2] ?? resolve('../Sable/node_modules/@matrix-org/matrix-sdk-crypto-wasm');
const target = new URL('./v1-crypto-18.4.json', import.meta.url).pathname;
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.end('<!doctype html><title>Isolated migration fixture</title>');
    return;
  }
  const path = req.url?.slice(1);
  if (
    ![
      'index.mjs',
      'pkg/matrix_sdk_crypto_wasm_bg.js',
      'pkg/matrix_sdk_crypto_wasm_bg.wasm',
    ].includes(path)
  ) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    'Content-Type',
    path.endsWith('.wasm') ? 'application/wasm' : 'application/javascript'
  );
  res.end(await readFile(resolve(packageRoot, path)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') process.stderr.write(msg.text() + '\n');
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const fixture = await page.evaluate(async () => {
    const sdk = await import('/index.mjs');
    await sdk.initAsync();
    const userId = '@migration:example.org';
    const deviceId = 'V1DEVICE';
    const prefix = 'sync@migration:example.org';
    const machine = await sdk.OlmMachine.initialize(
      new sdk.UserId(userId),
      new sdk.DeviceId(deviceId),
      prefix
    );
    const identity = machine.identityKeys;
    const identityKeys = {
      ed25519: identity.ed25519.toBase64(),
      curve25519: identity.curve25519.toBase64(),
    };
    await machine.bootstrapCrossSigning(false);
    await machine.updateTrackedUsers([new sdk.UserId('@peer:example.org')]);
    const peerUser = '@peer:example.org';
    const peerDevice = 'PEERDEVICE';
    const peer = await sdk.OlmMachine.initialize(
      new sdk.UserId(peerUser),
      new sdk.DeviceId(peerDevice),
      'isolated-peer'
    );
    await peer.updateTrackedUsers([new sdk.UserId(userId)]);
    const machines = [
      { machine, userId, deviceId },
      { machine: peer, userId: peerUser, deviceId: peerDevice },
    ];
    const uploads = {};
    const pending = {};
    for (const actor of machines) {
      pending[actor.userId] = await actor.machine.outgoingRequests();
      const request = pending[actor.userId].find((r) => r.type === sdk.RequestType.KeysUpload);
      if (!request) throw new Error('No synthetic key upload');
      uploads[actor.userId] = JSON.parse(request.body);
      await actor.machine.markRequestAsSent(
        request.id,
        request.type,
        JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 } })
      );
    }
    const deviceKeys = Object.fromEntries(
      machines.map((actor) => [
        actor.userId,
        { [actor.deviceId]: uploads[actor.userId].device_keys },
      ])
    );
    for (const actor of machines) {
      for (const request of pending[actor.userId]) {
        if (request.type === sdk.RequestType.KeysQuery)
          await actor.machine.markRequestAsSent(
            request.id,
            request.type,
            JSON.stringify({ device_keys: deviceKeys, failures: {} })
          );
      }
    }
    const peerOnMain = await machine.getDevice(
      new sdk.UserId(peerUser),
      new sdk.DeviceId(peerDevice)
    );
    if (!peerOnMain) throw new Error('Synthetic peer device was not accepted');
    await peerOnMain.setLocalTrust(sdk.LocalTrust.Verified);
    for (const [actor, other] of [
      [machines[0], machines[1]],
      [machines[1], machines[0]],
    ]) {
      const request = await actor.machine.getMissingSessions([new sdk.UserId(other.userId)]);
      if (request) {
        const oneTimeKeys = uploads[other.userId].one_time_keys;
        const first = Object.entries(oneTimeKeys)[0];
        if (!first) throw new Error('No synthetic one-time key');
        await actor.machine.markRequestAsSent(
          request.id,
          request.type,
          JSON.stringify({
            one_time_keys: { [other.userId]: { [other.deviceId]: { [first[0]]: first[1] } } },
            failures: {},
          })
        );
      }
    }
    const incoming = await peer.shareRoomKey(
      new sdk.RoomId('!peer-room:example.org'),
      [new sdk.UserId(userId)],
      new sdk.EncryptionSettings()
    );
    for (const request of incoming) {
      const body = JSON.parse(request.body);
      const content = body.messages[userId]?.[deviceId];
      if (!content) throw new Error('No targeted encrypted room key');
      await machine.receiveSyncChanges(
        JSON.stringify([{ type: request.event_type, sender: peerUser, content }]),
        new sdk.DeviceLists(),
        new Map()
      );
      await peer.markRequestAsSent(request.id, request.type, '{}');
    }
    const roomId = '!migration:example.org';
    const settings = new sdk.EncryptionSettings();
    await machine.shareRoomKey(new sdk.RoomId(roomId), [], settings);
    const plaintext = { msgtype: 'm.text', body: 'Generated by v1 matrix-sdk-crypto-wasm 18.4.0' };
    const encrypted = JSON.parse(
      await machine.encryptRoomEvent(
        new sdk.RoomId(roomId),
        'm.room.message',
        JSON.stringify(plaintext)
      )
    );
    const roomSettings = new sdk.RoomSettings();
    roomSettings.algorithm = sdk.EncryptionAlgorithm.MegolmV1AesSha2;
    await machine.setRoomSettings(new sdk.RoomId(roomId), roomSettings);
    await machine.setHasDownloadedAllRoomKeys(new sdk.RoomId(roomId));
    await machine.storeRoomPendingKeyBundle(
      new sdk.RoomId('!pending:example.org'),
      new sdk.UserId('@inviter:example.org')
    );
    await machine.saveBackupDecryptionKey(sdk.BackupDecryptionKey.createRandomKey(), '1');
    const localDecrypted = await machine.decryptRoomEvent(
      JSON.stringify({
        type: 'm.room.encrypted',
        event_id: '$v1-migration-fixture',
        sender: userId,
        origin_server_ts: 0,
        content: encrypted,
      }),
      new sdk.RoomId(roomId),
      new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted)
    );
    const decryptedJson = JSON.parse(localDecrypted.event);
    if (decryptedJson.content.body !== plaintext.body)
      throw new Error('Source runtime could not decrypt its fixture message');
    peer.close();
    machine.close();
    const dbName = `${prefix}::matrix-sdk-crypto`;
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const stores = [];
    const normalize = (value) =>
      ArrayBuffer.isView(value)
        ? Array.from(value)
        : value instanceof ArrayBuffer
          ? Array.from(new Uint8Array(value))
          : Array.isArray(value)
            ? value.map(normalize)
            : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
              : value;
    for (const name of db.objectStoreNames) {
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly');
        const records = [];
        const r = tx.objectStore(name).openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (c) {
            records.push({ key: normalize(c.key), value: normalize(c.value) });
            c.continue();
          }
        };
        tx.oncomplete = () => resolve(records);
        tx.onerror = () => reject(tx.error);
      });
      const store = db.transaction(name).objectStore(name);
      const indexes = Array.from(store.indexNames).map((name) => {
        const index = store.index(name);
        return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      });
      stores.push({
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
        records,
      });
    }
    const version = db.version;
    db.close();
    return {
      source: {
        package: '@matrix-org/matrix-sdk-crypto-wasm',
        version: '18.4.0',
        sdk_revision: 'fd95d90bf9f93a3aa68376b1cbdffc3cada2c7b3',
        generated_in: 'Isolated Chromium browser context; synthetic test identity',
      },
      user_id: userId,
      device_id: deviceId,
      identity_keys: identityKeys,
      room_id: roomId,
      plaintext,
      encrypted_event: {
        type: 'm.room.encrypted',
        event_id: '$v1-migration-fixture',
        sender: userId,
        origin_server_ts: 0,
        content: encrypted,
      },
      database: { name: dbName, version, stores },
    };
  });
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(fixture, null, 2) + '\n');
  console.log(
    JSON.stringify({
      target,
      version: fixture.database.version,
      counts: Object.fromEntries(fixture.database.stores.map((s) => [s.name, s.records.length])),
    })
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
