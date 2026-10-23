import { expect, test, type Page } from '@playwright/test';

import type { Client } from '../../src/lib/runtime/client';
import type { Subscription } from '../../src/lib/runtime/subscription';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

type ClientModule = typeof import('../../src/lib/runtime/client');
type WebRuntimeModule = typeof import('../../src/transport/web-runtime');

interface Heard {
  subs: number[];
  replies: number[];
  restarts: number;
}

type TabWindow = Window & {
  client: Client;
  store: Subscription<{ count: number }>;
  heard: Heard;
  stale?: true;
};

// Where the dev server serves the modules the app itself runs, so the page shares their state.
const CLIENT_MODULE: string = '/src/lib/runtime/client.ts';
const WEB_RUNTIME_MODULE: string = '/src/transport/web-runtime.ts';

const counter = { slice: 'counter', key: null };

async function connectTab(page: Page) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome to Sable' })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  await page.evaluate(
    async ([clientModule, webRuntimeModule]) => {
      const { connect } = (await import(clientModule)) as ClientModule;
      const { createWebLink } = (await import(webRuntimeModule)) as WebRuntimeModule;
      const link = createWebLink();
      const heard: Heard = { subs: [], replies: [], restarts: 0 };
      link.onRestart?.(() => {
        heard.restarts += 1;
      });
      link.onBatch(({ events }) => {
        for (const event of events) {
          if (event.type === 'patch') heard.subs.push(event.sub);
          if (event.type === 'reply') heard.replies.push(event.req);
        }
      });
      const client = await connect(link, { needed: ['counter'] });
      const store = client.subscribe<{ count: number }>({ slice: 'counter', key: null });
      await store.loaded;
      Object.assign(window, { client, store, heard });
    },
    [CLIENT_MODULE, WEB_RUNTIME_MODULE]
  );
}

const count = (page: Page) =>
  page.evaluate(() => (window as unknown as TabWindow).store.get()?.count);

const heard = (page: Page) => page.evaluate(() => (window as unknown as TabWindow).heard);

const dispatch = (page: Page, action: object) =>
  page.evaluate(
    ([target, body]) =>
      (window as unknown as TabWindow).client.dispatch(target, body).catch(() => {}),
    [counter, action] as const
  );

/** The counter value in the worker's delayed snapshot. */
const saved = (page: Page) =>
  page.evaluate(async () => {
    const name = 'sable-next::snapshots';
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return null;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('could not open the snapshots'));
      };
    });
    const stored = await new Promise<unknown>((resolve) => {
      const request = database
        .transaction('snapshots')
        .objectStore('snapshots')
        .get('snapshot//counter/null');
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
    database.close();
    if (typeof stored !== 'string') return null;
    const parsed = JSON.parse(stored) as { view?: { count?: unknown } };
    return typeof parsed.view?.count === 'number' ? parsed.view.count : null;
  });

test.describe('two tabs of one worker', () => {
  test('each tab follows its own subscription and gets its own replies', async ({ context }) => {
    const [one, two] = [await context.newPage(), await context.newPage()];
    await connectTab(one);
    await connectTab(two);

    await dispatch(one, { type: 'add', n: 5 });
    await expect.poll(() => count(one)).toBe(5);
    await expect.poll(() => count(two)).toBe(5);

    const doubled = await two.evaluate(
      ([target, body]) => (window as unknown as TabWindow).client.request(target, body),
      [counter, { type: 'double' }] as const
    );
    expect(doubled).toBe(10);
    await expect.poll(() => count(one)).toBe(10);

    const [first, second] = [await heard(one), await heard(two)];
    expect(new Set(first.subs).size).toBe(1);
    expect(new Set(second.subs).size).toBe(1);
    expect(first.subs[0]).not.toBe(second.subs[0]);
    expect(first.replies).toEqual([]);
    expect(second.replies).toHaveLength(1);
  });

  test('a tab whose handshake does not match reloads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome to Sable' })).toBeVisible({
      timeout: COLD_BOOT_TIMEOUT,
    });
    await page.evaluate(() => {
      (window as unknown as TabWindow).stale = true;
      sessionStorage.removeItem('sable-runtime-reloaded');
    });

    await page.evaluate(async (webRuntimeModule) => {
      const { createWebLink, startLink } = (await import(webRuntimeModule)) as WebRuntimeModule;
      void startLink(() => ({
        ...createWebLink(),
        handshake: () => Promise.resolve({ schema: '0000000000000000', slices: [] }),
      }));
    }, WEB_RUNTIME_MODULE);

    await page.waitForFunction(() => !('stale' in window));
    await expect(page.getByRole('heading', { name: 'Welcome to Sable' })).toBeVisible({
      timeout: COLD_BOOT_TIMEOUT,
    });
  });

  test('a worker that panics restarts, and the tabs subscribe to the new one', async ({
    context,
  }) => {
    const [one, two] = [await context.newPage(), await context.newPage()];
    await connectTab(one);
    await connectTab(two);
    await dispatch(one, { type: 'add', n: 3 });
    await expect.poll(() => count(two)).toBe(3);
    await expect.poll(() => saved(one), { timeout: 10_000 }).toBe(3);

    await dispatch(two, { type: 'panic' });
    for (const page of [one, two]) {
      await expect.poll(async () => (await heard(page)).restarts).toBe(1);
    }

    await dispatch(one, { type: 'add', n: 1 });
    await expect.poll(() => count(one), { timeout: 20_000 }).toBe(4);
    await expect.poll(() => count(two), { timeout: 20_000 }).toBe(4);
  });
});
