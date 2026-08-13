import { test as base, type Page } from '@playwright/test';

type WorkerMode = 'ready' | 'loading' | 'error';

type Session = {
  account_id: string;
  user_id: string;
  device_id: string;
};

type Fixtures = {
  installFakeCore: (mode: WorkerMode) => Promise<void>;
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
  installFakeCore: async ({ page, workerSession }, use) => {
    await use((mode) => installFakeCore(page, mode, workerSession));
  },
});

export { expect } from '@playwright/test';

async function installFakeCore(page: Page, mode: WorkerMode, session: Session): Promise<void> {
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
