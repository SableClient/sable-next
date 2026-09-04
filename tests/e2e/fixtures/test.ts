import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import type { Command } from '#src/generated/Command';
import type { CommandOk } from '#src/generated/CommandOk';
import { AuthFlow } from '../pages/AuthFlow';
import { AppShell } from '../pages/AppShell';
import { RoomTimeline } from '../pages/RoomTimeline';
import { FakeCoreDriver } from '../pages/FakeCoreDriver';
import { installFakeCore as installRoomCore, type RoomCoreMode } from '../fake-core';
import { registerUser, type TestHomeserver } from './continuwuity';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './loginAccount';
import { MatrixAdmin } from './matrix';
import { HomeserverProxy } from './proxy';
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

export const SIGNED_OUT = { cookies: [], origins: [] };

export const GUEST_DISPLAY_NAME = 'Ada';

type WorkerAccount = {
  admin: MatrixAdmin;
  guest: MatrixAdmin;
  username: string;
};

const SPACE_NAMES = ['Alpha', 'Beta', 'Gamma'] as const;

const ALPHA_TOPIC =
  'A topic long enough to clamp: it introduces the space, lists the rules, thanks the moderators and links the map. It repeats itself at length so the hero has something to cut: the rules again, the moderators again, the map again, and a closing paragraph that keeps going well past the three lines the hero shows before it hands the rest to the dialog.';

export type SpaceTree = {
  account: MatrixAdmin;
  alphaId: string;
  betaId: string;
  gammaId: string;
  nestedId: string;
  deepRoomId: string;
  children: { name: string; roomId: string }[];
  refusedId: string;
};

const SEARCH_SENDER_NAME = 'Alice';
const SEARCH_MESSAGES_PER_ROOM = 20;

export type SearchCorpus = {
  statePath: string;
  generalId: string;
  randomId: string;
  sender: MatrixAdmin;
};

function searchBodies(room: string, count = SEARCH_MESSAGES_PER_ROOM): string[] {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? `Welcome to ${room}` : `${room} message ${String(index)}`
  );
}

const DEEP_ROOM_MESSAGES = 120;

export type DeepRoom = {
  roomId: string;
  eventIds: string[];
  bodies: string[];
};

function deepRoomBodies(count = DEEP_ROOM_MESSAGES): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `Deep message ${String(index)}${index % 7 === 0 ? ` ${'wraps and wraps '.repeat(6)}` : ''}`
  );
}

type Fixtures = {
  app: AppShell;
  auth: AuthFlow;
  timeline: RoomTimeline;
  core: FakeCoreDriver;
  installEmptyCore: (mode: WorkerMode) => Promise<void>;
  installRoomCore: (mode: RoomCoreMode) => Promise<void>;
  homeserver: TimelineHomeserver;
  admin: MatrixAdmin;
  guest: MatrixAdmin;
  bootstrap: MatrixAdmin;
  homeserverProxy: HomeserverProxy;
  deepRoom: DeepRoom;
  searchCorpus: SearchCorpus;
  spacesLogin: () => Promise<MatrixAdmin>;
  spaceTree: SpaceTree;
  signIn: () => Promise<void>;
  freshLogin: () => Promise<MatrixAdmin>;
  proxiedLogin: () => Promise<MatrixAdmin>;
  scratchRoom: { roomId: string; name: string };
};

type WorkerFixtures = {
  workerSession: Session;
  workerAccount: WorkerAccount;
  workerProxy: HomeserverProxy;
  workerDeepRoom: DeepRoom;
  workerSearchCorpus: SearchCorpus;
  workerStorageState: string;
};

async function readHomeserver(): Promise<TimelineHomeserver> {
  return JSON.parse(await readFile(homeserverStatePath(), 'utf8')) as TimelineHomeserver;
}

async function signInThroughUi(page: Page, homeserverUrl: string, username: string): Promise<void> {
  const auth = new AuthFlow(page);
  await auth.open(homeserverUrl);
  await expect(auth.moreMethodsButton).toBeVisible({ timeout: 60_000 });
  await auth.revealPasswordLogin();
  await auth.signInWithPassword(username, LOGIN_PASSWORD);
  await expect(page).toHaveURL(/\/login\/verify$/, { timeout: 30_000 });
  await auth.leaveVerificationButton.click();
  await expect(page).toHaveURL(/\/rooms$/, { timeout: 30_000 });
}

async function saveSignedInState(
  browser: import('@playwright/test').Browser,
  baseURL: string | undefined,
  homeserverUrl: string,
  username: string,
  path: string,
  settle?: (page: Page) => Promise<void>
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInThroughUi(page, homeserverUrl, username);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible({
    timeout: 30_000,
  });
  await settle?.(page);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(await context.storageState({ indexedDB: true })));
  await context.close();
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  storageState: ({ workerStorageState }, use) => use(workerStorageState),

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

  workerProxy: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const homeserver = await readHomeserver();
      const proxy = await HomeserverProxy.start(homeserver.baseUrl);
      await use(proxy);
      await proxy.stop();
    },
    { scope: 'worker' },
  ],

  workerDeepRoom: [
    async ({ workerAccount }, use, workerInfo) => {
      const { admin } = workerAccount;
      const roomId = await admin.createRoom({
        name: `Deep history ${workerInfo.project.name}-${String(workerInfo.parallelIndex)}`,
      });
      const bodies = deepRoomBodies();
      const eventIds: string[] = [];
      for (const body of bodies) eventIds.push(await admin.sendMessage(roomId, body));
      await use({ roomId, eventIds, bodies });
    },
    { scope: 'worker' },
  ],

  deepRoom: async ({ workerDeepRoom }, use) => {
    await use(workerDeepRoom);
  },

  workerSearchCorpus: [
    async ({ browser }, use, workerInfo) => {
      const homeserver = await readHomeserver();
      const suffix = `${workerInfo.project.name.toLowerCase()}-${String(workerInfo.parallelIndex)}`;
      const reader = await registerUser(homeserver.baseUrl, `search-${suffix}`, LOGIN_PASSWORD);
      const senderAccount = await registerUser(
        homeserver.baseUrl,
        `alice-${suffix}`,
        LOGIN_PASSWORD
      );
      const sender = new MatrixAdmin(
        homeserver.baseUrl,
        senderAccount.accessToken,
        senderAccount.userId
      );
      const readerAdmin = new MatrixAdmin(homeserver.baseUrl, reader.accessToken, reader.userId);
      await sender.setDisplayName(SEARCH_SENDER_NAME);

      const existing = await sender.roomsByName();
      const generalId =
        existing.get('General') ??
        (await sender.createRoom({ name: 'General', invite: [reader.userId] }));
      const randomId =
        existing.get('Random') ??
        (await sender.createRoom({ name: 'Random', invite: [reader.userId] }));
      if (!existing.has('General')) {
        await readerAdmin.join(generalId);
        for (const body of searchBodies('General')) await sender.sendMessage(generalId, body);
      }
      if (!existing.has('Random')) {
        await readerAdmin.join(randomId);
        for (const body of searchBodies('Random')) await sender.sendMessage(randomId, body);
      }

      const statePath = join('tests/e2e/.auth', `search-${suffix}.json`);
      await saveSignedInState(
        browser,
        workerInfo.project.use.baseURL,
        homeserver.baseUrl,
        `search-${suffix}`,
        statePath,
        async (page) => {
          const shell = new AppShell(page);
          for (const roomId of [generalId, randomId]) {
            await shell.openRoom(roomId);
            await expect(
              page.locator('.timeline-viewport .item[data-event-id]').first()
            ).toBeVisible({ timeout: 30_000 });
          }
        }
      );

      await use({ statePath, generalId, randomId, sender });
    },
    { scope: 'worker' },
  ],

  searchCorpus: async ({ workerSearchCorpus }, use) => {
    await use(workerSearchCorpus);
  },

  homeserverProxy: async ({ workerProxy }, use) => {
    workerProxy.reset();
    await use(workerProxy);
    workerProxy.reset();
  },

  proxiedLogin: async ({ page, homeserver, workerProxy }, use, testInfo) => {
    await use(async () => {
      const username = `proxied-${String(testInfo.parallelIndex)}-${String(Date.now())}`;
      const account = await registerUser(homeserver.baseUrl, username, LOGIN_PASSWORD);
      await signInThroughUi(page, workerProxy.baseUrl, username);
      return new MatrixAdmin(homeserver.baseUrl, account.accessToken, account.userId);
    });
  },

  workerAccount: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const homeserver = await readHomeserver();
      const suffix = `${workerInfo.project.name.toLowerCase()}-${String(workerInfo.parallelIndex)}`;
      const username = `worker-${suffix}`;
      const owner = await registerUser(homeserver.baseUrl, username, LOGIN_PASSWORD);
      const host = await registerUser(homeserver.baseUrl, `guest-${suffix}`, LOGIN_PASSWORD);
      const guest = new MatrixAdmin(homeserver.baseUrl, host.accessToken, host.userId);
      await guest.setDisplayName(GUEST_DISPLAY_NAME);
      await use({
        admin: new MatrixAdmin(homeserver.baseUrl, owner.accessToken, owner.userId),
        guest,
        username,
      });
    },
    { scope: 'worker' },
  ],

  workerStorageState: [
    async ({ browser, workerAccount }, use, workerInfo) => {
      const path = join(
        'tests/e2e/.auth',
        `worker-${workerInfo.project.name}-${String(workerInfo.parallelIndex)}.json`
      );
      const homeserver = await readHomeserver();
      await saveSignedInState(
        browser,
        workerInfo.project.use.baseURL,
        homeserver.baseUrl,
        workerAccount.username,
        path
      );

      await use(path);
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
  // oxlint-disable-next-line no-empty-pattern
  homeserver: async ({}, use) => {
    await use(await readHomeserver());
  },
  admin: async ({ workerAccount }, use) => {
    await use(workerAccount.admin);
  },
  guest: async ({ workerAccount }, use) => {
    await use(workerAccount.guest);
  },
  bootstrap: async ({ homeserver }, use) => {
    const { user_id: userId } = await fetch(
      `${homeserver.baseUrl}/_matrix/client/v3/account/whoami`,
      {
        headers: { authorization: `Bearer ${homeserver.accessToken}` },
      }
    ).then((response) => response.json() as Promise<{ user_id: string }>);
    await use(new MatrixAdmin(homeserver.baseUrl, homeserver.accessToken, userId));
  },

  scratchRoom: async ({ bootstrap }, use, testInfo) => {
    const name = `Scratch ${String(testInfo.parallelIndex)} ${testInfo.testId}`;
    const roomId = await bootstrap.createRoom({ name });
    // Sync orders rooms by activity, so an empty one can stay outside the window.
    await bootstrap.sendMessage(roomId, 'Scratch room opened');
    await use({ roomId, name });
  },
  freshLogin: async ({ page, homeserver }, use, testInfo) => {
    await use(async () => {
      const username = `fresh-${String(testInfo.parallelIndex)}-${String(Date.now())}`;
      const account = await registerUser(homeserver.baseUrl, username, LOGIN_PASSWORD);
      await signInThroughUi(page, homeserver.baseUrl, username);
      return new MatrixAdmin(homeserver.baseUrl, account.accessToken, account.userId);
    });
  },
  spacesLogin: async ({ page, homeserver }, use, testInfo) => {
    await use(async () => {
      const username = `spaces-${String(testInfo.parallelIndex)}-${String(Date.now())}`;
      const registered = await registerUser(homeserver.baseUrl, username, LOGIN_PASSWORD);
      const account = new MatrixAdmin(
        homeserver.baseUrl,
        registered.accessToken,
        registered.userId
      );
      for (const name of SPACE_NAMES) {
        await account.createRoom({ name, isSpace: true });
      }
      await signInThroughUi(page, homeserver.baseUrl, username);
      return account;
    });
  },

  spaceTree: async ({ page, spacesLogin, guest }, use) => {
    const tree = await (async () => {
      const account = await spacesLogin();
      const joined = await account.request<{ joined_rooms: string[] }>(
        'GET',
        'client/v3/joined_rooms'
      );
      const named = await Promise.all(
        joined.joined_rooms.map(async (roomId) => ({
          roomId,
          name: await account
            .request<{ name?: string }>(
              'GET',
              `client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`
            )
            .then((state) => state.name ?? '')
            .catch(() => ''),
        }))
      );
      const idOf = (name: string) => {
        const found = named.find((entry) => entry.name === name);
        if (!found) throw new Error(`no space named ${name}`);
        return found.roomId;
      };

      const alphaId = idOf('Alpha');
      await account.sendStateEvent(alphaId, 'm.room.topic', '', { topic: ALPHA_TOPIC });

      const nestedId = await account.createRoom({ name: 'Nested', isSpace: true });
      const deepRoomId = await account.createRoom({ name: 'Deep Room', preset: 'public_chat' });
      const children: { name: string; roomId: string }[] = [];
      for (const name of ['Late Arrival', 'Middle Room', 'Tail Room']) {
        children.push({ name, roomId: await account.createRoom({ name, preset: 'public_chat' }) });
      }

      const refusedId = await guest.createRoom({ name: 'Refused Space', isSpace: true });

      await account.addSpaceChild(alphaId, nestedId, { order: 'a' });
      for (const [index, child] of children.entries()) {
        await account.addSpaceChild(alphaId, child.roomId, {
          order: String.fromCharCode('b'.charCodeAt(0) + index),
        });
      }
      await account.addSpaceChild(alphaId, refusedId, { order: 'z' });
      await account.addSpaceChild(nestedId, deepRoomId, { order: 'a' });

      return {
        account,
        alphaId,
        betaId: idOf('Beta'),
        gammaId: idOf('Gamma'),
        nestedId,
        deepRoomId,
        children,
        refusedId,
      };
    })();
    await page.goto('/rooms');
    await expect(
      page
        .getByRole('navigation', { name: 'Primary navigation' })
        .getByRole('link', { name: 'Alpha' })
    ).toBeVisible({ timeout: 30_000 });
    await use(tree);
  },

  signIn: async ({ auth, page, homeserver }, use) => {
    await use(async () => {
      await auth.open(homeserver.baseUrl);
      await auth.revealPasswordLogin();
      await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);
      await expect(page).toHaveURL(/\/login\/verify$/);
      await auth.leaveVerificationButton.click();
      await expect(page).toHaveURL(/\/rooms$/);
    });
  },
});

export { expect } from '@playwright/test';

async function installEmptyCore(page: Page, mode: WorkerMode, session: Session): Promise<void> {
  await page.addInitScript(
    ({ workerMode, workerSession }: { workerMode: WorkerMode; workerSession: Session }) => {
      type CommandType = Command['type'];
      type OkFor<T extends CommandType> = Extract<CommandOk, { type: T }>;
      type BareCommandType = {
        [T in CommandType]: keyof OkFor<T> extends 'type' ? T : never;
      }[CommandType];

      const bareReply = <T extends CommandType>(type: T): OkFor<T> => ({ type }) as OkFor<T>;

      const reply = (command: Command): CommandOk =>
        command.type === 'restore'
          ? { type: 'restore', session: workerSession }
          : command.type === 'list_accounts'
            ? { type: 'list_accounts', accounts: [workerSession] }
            : command.type === 'subscribe_room_list'
              ? { type: 'subscribe_room_list', subscription: 1, rooms: [] }
              : bareReply(command.type as BareCommandType);

      class FakePort {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent) => void) | null = null;

        start(): void {}

        close(): void {}

        postMessage(request: { id: number; command?: Command }): void {
          const command = request.command;
          if (!command) return;
          if (workerMode === 'loading' && command.type === 'restore') return;

          const response =
            workerMode === 'error' && command.type === 'restore'
              ? { id: request.id, err: { code: 'unavailable' } }
              : { id: request.id, ok: reply(command) };

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
