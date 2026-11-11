import { expect, test as base, type Page } from '@playwright/test';

import { AuthFlow } from './pages/AuthFlow';
import {
  CALL_HOMESERVER_URL,
  CALL_PASSWORD,
  callStackLogs,
  createCallRoom,
  joinCallRoom,
  registerCallUser,
  startCallStack,
  stopCallStack,
} from './fixtures/call-stack';

const ROOM_NAME = 'Rejoin call';

const test = base.extend({});

test.use({
  storageState: { cookies: [], origins: [] },
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone', 'camera'],
});

test.describe.configure({ mode: 'serial' });
test.setTimeout(200_000);

async function signIn(page: Page, username: string): Promise<void> {
  const auth = new AuthFlow(page);
  await auth.open(CALL_HOMESERVER_URL);
  await expect(auth.moreMethodsButton).toBeVisible({ timeout: 60_000 });
  await auth.revealPasswordLogin();
  await auth.signInWithPassword(username, CALL_PASSWORD);
  await auth.finishSetup();
  await expect(page).toHaveURL(/\/rooms$/, { timeout: 30_000 });
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);
  await expect(page.getByRole('heading', { name: ROOM_NAME })).toBeVisible({ timeout: 60_000 });
}

async function enterCall(page: Page, via: RegExp | string): Promise<void> {
  await page
    .getByRole('button', { name: via, exact: typeof via === 'string' })
    .click({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Hang up/ }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function leaveCall(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Hang up/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /^Hang up/ })).toHaveCount(0, { timeout: 30_000 });
}

async function expectRemoteAudio(page: Page, minimumBytes: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLAudioElement>('.audio audio[data-identity]')].filter(
              (element) => {
                const stream = element.srcObject;
                return (
                  stream instanceof MediaStream &&
                  stream
                    .getAudioTracks()
                    .some((track) => track.readyState === 'live' && !track.muted)
                );
              }
            ).length
        ),
      { timeout: 60_000, message: 'a live remote audio element' }
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() => inboundAudioBytes(page), { timeout: 30_000, message: 'inbound audio bytes' })
    .toBeGreaterThan(minimumBytes);
}

async function inboundAudioBytes(page: Page): Promise<number> {
  return page.evaluate(async (): Promise<number> => {
    const peers = (window as unknown as { __sablePeers?: RTCPeerConnection[] }).__sablePeers;
    let bytes = 0;
    for (const peer of peers ?? []) {
      if (peer.connectionState === 'closed') continue;
      const stats = await peer.getStats();
      for (const report of stats.values() as Iterable<{
        type: string;
        kind?: string;
        bytesReceived?: number;
      }>) {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          bytes += report.bytesReceived ?? 0;
        }
      }
    }
    return bytes;
  });
}

for (const encrypted of [false, true]) {
  test(`a call still carries audio after one side leaves and rejoins in ${encrypted ? 'an encrypted' : 'a plain'} room`, async ({
    browser,
  }) => {
    await startCallStack();
    try {
      const alice = await registerCallUser('alice');
      const bob = await registerCallUser('bob');
      const roomId = await createCallRoom(alice.accessToken, ROOM_NAME, [bob.userId], encrypted);
      await joinCallRoom(bob.accessToken, roomId);

      const contexts = await Promise.all(
        [0, 1].map(() =>
          browser.newContext({
            baseURL: `http://127.0.0.1:${process.env.SABLE_PREVIEW_PORT ?? '4173'}`,
            permissions: ['microphone', 'camera'],
          })
        )
      );
      const [aliceContext, bobContext] = contexts;
      for (const context of contexts) {
        await context.addInitScript(() => {
          const peers: RTCPeerConnection[] = [];
          (window as unknown as { __sablePeers: RTCPeerConnection[] }).__sablePeers = peers;
          const Native = window.RTCPeerConnection;
          window.RTCPeerConnection = new Proxy(Native, {
            construct(target, args: ConstructorParameters<typeof RTCPeerConnection>) {
              const peer = new target(...args);
              peers.push(peer);
              return peer;
            },
          });
        });
      }
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();
      for (const [name, page] of [
        ['alice', alicePage],
        ['bob', bobPage],
      ] as const) {
        page.on('console', (message) => {
          console.log(`[${name}] ${message.type()} ${message.text()}`);
        });
      }

      try {
        await signIn(alicePage, 'alice');
        await signIn(bobPage, 'bob');
        await openRoom(alicePage, roomId);
        await openRoom(bobPage, roomId);

        await enterCall(alicePage, /^Start call$/);
        await enterCall(bobPage, 'Accept');
        await expectRemoteAudio(alicePage, 0);
        await expectRemoteAudio(bobPage, 0);

        for (const [leaver, stayer] of [
          [alicePage, bobPage],
          [alicePage, bobPage],
          [bobPage, alicePage],
          [bobPage, alicePage],
        ]) {
          await leaveCall(leaver);
          await enterCall(leaver, /^Join call$/);
          const leaverBefore = await inboundAudioBytes(leaver);
          const stayerBefore = await inboundAudioBytes(stayer);
          await expectRemoteAudio(leaver, leaverBefore + 2_000);
          await expectRemoteAudio(stayer, stayerBefore + 2_000);
        }

        await leaveCall(alicePage);
        await leaveCall(bobPage);
        await enterCall(alicePage, /^Start call$/);
        await enterCall(bobPage, 'Accept');
        await expectRemoteAudio(alicePage, 0);
        await expectRemoteAudio(bobPage, 0);
      } catch (error) {
        console.log(await callStackLogs());
        await alicePage.screenshot({ path: 'test-results/alice.png' });
        await bobPage.screenshot({ path: 'test-results/bob.png' });
        throw error;
      }
    } finally {
      await stopCallStack();
    }
  });
}
