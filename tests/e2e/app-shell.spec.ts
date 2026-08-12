import { expect, test, type Page } from '@playwright/test';

type WorkerMode = 'ready' | 'loading' | 'error';

async function installFakeCore(page: Page, mode: WorkerMode): Promise<void> {
  await page.addInitScript((workerMode: WorkerMode) => {
    const session = {
      account_id: 'e2e-account',
      user_id: '@e2e:example.test',
      device_id: 'E2EDEVICE',
    };

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
                    ? { type: 'restore', session }
                    : command === 'list_accounts'
                      ? { type: 'list_accounts', accounts: [session] }
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
  }, mode);
}

test('shows the authenticated app shell on desktop', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/home');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('navigation', { name: 'Quick tools' })).toBeVisible();
});

test('shows the authenticated app shell on mobile', async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('navigation', { name: 'Quick tools' })).toBeVisible();
});

test('renders a startup state while the core is restoring', async ({ page }) => {
  await installFakeCore(page, 'loading');
  await page.goto('/home');

  await expect(page.getByRole('status')).toContainText('Starting Sable');
  await expect(page.getByRole('heading', { name: 'Starting Sable' })).toBeVisible();
});

test('redirects signed-out protected routes to login', async ({ page }) => {
  await page.goto('/home');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('renders a recoverable error when the core cannot start', async ({ page }) => {
  await installFakeCore(page, 'error');
  await page.goto('/home');

  await expect(page.getByRole('alert')).toContainText('Sable could not start');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
