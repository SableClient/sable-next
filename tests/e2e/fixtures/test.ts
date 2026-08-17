import { readFile } from 'node:fs/promises';
import { expect, test as base, type Page } from '@playwright/test';
import { AuthFlow } from '../pages/AuthFlow';
import { AppShell } from '../pages/AppShell';
import { RoomTimeline } from '../pages/RoomTimeline';
import { FakeCoreDriver } from '../pages/FakeCoreDriver';
import { installFakeCore as installRoomCore, type RoomCoreMode } from '../fake-core';
import { createRoom, sendTimelineMessage, type TestHomeserver } from './continuwuity';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './loginAccount';
import { homeserverStatePath } from './runtime';

export type TimelineHomeserver = TestHomeserver & {
  timelineRoomId: string;
  timelineEventIds: string[];
  accessToken: string;
};

type WorkerMode = 'ready' | 'loading' | 'error';

type Session = {
  account_id: string;
  user_id: string;
  device_id: string;
};

type Fixtures = {
  app: AppShell;
  auth: AuthFlow;
  timeline: RoomTimeline;
  core: FakeCoreDriver;
  installEmptyCore: (mode: WorkerMode) => Promise<void>;
  installRoomCore: (mode: RoomCoreMode) => Promise<void>;
  homeserver: TimelineHomeserver;
  signIn: () => Promise<void>;
  scratchRoom: { roomId: string; name: string };
};

type WorkerFixtures = {
  workerSession: Session;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  workerSession: [
    async ({ browserName }, use, workerInfo) => {
      void browserName;
      const workerIndex = String(workerInfo.parallelIndex);
      const suffix = `${workerInfo.project.name}-${workerIndex}`;
      await use({
        account_id: `e2e-account-${suffix}`,
        user_id: `@e2e-${suffix}:example.test`,
        device_id: `E2EDEVICE${workerIndex}`,
      });
    },
    { scope: 'worker' },
  ],

  installEmptyCore: async ({ page, workerSession }, use) => {
    await use((mode) => installEmptyCore(page, mode, workerSession));
  },
  installRoomCore: async ({ page }, use) => {
    await use((mode) => installRoomCore(page, mode));
  },
  app: async ({ page }, use) => {
    await use(new AppShell(page));
  },
  auth: async ({ page }, use) => {
    await use(new AuthFlow(page));
  },
  timeline: async ({ page }, use) => {
    await use(new RoomTimeline(page));
  },
  core: async ({ page }, use) => {
    await use(new FakeCoreDriver(page));
  },
  // Playwright requires the destructuring pattern even with nothing to take.
  // eslint-disable-next-line no-empty-pattern
  homeserver: async ({}, use) => {
    const state = JSON.parse(await readFile(homeserverStatePath(), 'utf8')) as TimelineHomeserver;
    await use(state);
  },
  scratchRoom: async ({ homeserver }, use, testInfo) => {
    const name = `Scratch ${String(testInfo.parallelIndex)} ${testInfo.testId}`;
    const roomId = await createRoom(homeserver.baseUrl, homeserver.accessToken, name);
    // Sync orders rooms by activity, so an empty one can stay outside the window.
    await sendTimelineMessage(
      homeserver.baseUrl,
      homeserver.accessToken,
      roomId,
      `${testInfo.testId}-seed`,
      'Scratch room opened'
    );
    await use({ roomId, name });
  },
  signIn: async ({ auth, page, homeserver }, use) => {
    await use(async () => {
      await auth.open(homeserver.baseUrl);
      await auth.revealPasswordLogin();
      await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);
      await expect(page).toHaveURL(/\/login\/verify$/);
      await auth.leaveVerificationButton.click();
      await expect(page).toHaveURL(/\/home$/);
    });
  },
});

export { expect } from '@playwright/test';

async function installEmptyCore(page: Page, mode: WorkerMode, session: Session): Promise<void> {
  await page.addInitScript(
    ({ workerMode, workerSession }: { workerMode: WorkerMode; workerSession: Session }) => {
      class FakePort {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent) => void) | null = null;

        start(): void {}

        close(): void {}

        postMessage(request: { id: number; command?: { type: string } }): void {
          const command = request.command?.type;
          if (workerMode === 'loading' && command === 'restore') return;

          const response =
            workerMode === 'error' && command === 'restore'
              ? { id: request.id, err: { code: 'unavailable' } }
              : {
                  id: request.id,
                  ok:
                    command === 'restore'
                      ? { type: 'restore', session: workerSession }
                      : command === 'list_accounts'
                        ? { type: 'list_accounts', accounts: [workerSession] }
                        : command === 'subscribe_room_list'
                          ? { type: 'subscribe_room_list', subscription: 1, rooms: [] }
                          : command === 'unsubscribe'
                            ? { type: 'unsubscribe' }
                            : { type: command },
                };

          window.setTimeout(() => {
            this.onmessage?.({ data: response } as MessageEvent);
          }, 0);
        }
      }

      class FakeSharedWorker {
        port = new FakePort();

        addEventListener(): void {}
      }

      Object.defineProperty(window, 'SharedWorker', {
        configurable: true,
        value: FakeSharedWorker,
      });
    },
    { workerMode: mode, workerSession: session }
  );
}
