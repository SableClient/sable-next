import { expect, test, vi } from 'vitest';
import {
  SEARCH_DATABASE_LOCK,
  createSearchDatabaseHost,
  type CoreEndpoint,
} from './search-db-host';

function fakes() {
  const workers: { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }[] =
    [];
  let granted: (() => Promise<never>) | null = null;
  const locks = {
    request: vi.fn((name: string, callback: () => Promise<never>) => {
      expect(name).toBe(SEARCH_DATABASE_LOCK);
      granted = callback;
      return new Promise<never>(() => {});
    }),
  };
  const channels: { port1: MessagePort; port2: MessagePort }[] = [];
  const core = { postMessage: vi.fn() } satisfies CoreEndpoint;
  const host = createSearchDatabaseHost({
    locks: locks as unknown as LockManager,
    spawn: () => {
      const worker = { postMessage: vi.fn(), terminate: vi.fn() };
      workers.push(worker);
      return worker;
    },
    channel: () => {
      const channel = { port1: {} as MessagePort, port2: {} as MessagePort };
      channels.push(channel);
      return channel;
    },
  });
  return { host, core, workers, channels, locks, grant: () => granted?.() };
}

test('nothing starts until this tab holds the lock', () => {
  const { host, core, workers } = fakes();

  host.attach(core);

  expect(workers).toHaveLength(0);
  expect(core.postMessage).not.toHaveBeenCalled();
});

test('the tab that gets the lock starts the worker and hands each side a port', () => {
  const { host, core, workers, channels, grant } = fakes();
  host.attach(core);

  void grant();

  expect(workers).toHaveLength(1);
  expect(workers[0].postMessage).toHaveBeenCalledWith({ port: channels[0].port1 }, [
    channels[0].port1,
  ]);
  expect(core.postMessage).toHaveBeenCalledWith({ searchPort: channels[0].port2 }, [
    channels[0].port2,
  ]);
});

test('a replaced core gets a fresh channel from the worker already running', () => {
  const { host, core, workers, channels, grant } = fakes();
  host.attach(core);
  void grant();
  const next = { postMessage: vi.fn() } satisfies CoreEndpoint;

  host.attach(next);

  expect(workers).toHaveLength(1);
  expect(channels).toHaveLength(2);
  expect(next.postMessage).toHaveBeenCalledWith({ searchPort: channels[1].port2 }, [
    channels[1].port2,
  ]);
});

test('the lock is requested once however often the core attaches', () => {
  const { host, core, locks } = fakes();

  host.attach(core);
  host.attach(core);

  expect(locks.request).toHaveBeenCalledTimes(1);
});

test('a browser without locks starts the worker at once', () => {
  const workers: unknown[] = [];
  const core = { postMessage: vi.fn() } satisfies CoreEndpoint;
  const host = createSearchDatabaseHost({
    locks: undefined,
    spawn: () => {
      const worker = { postMessage: vi.fn(), terminate: vi.fn() };
      workers.push(worker);
      return worker;
    },
    channel: () => ({ port1: {}, port2: {} }) as MessageChannel,
  });

  host.attach(core);

  expect(workers).toHaveLength(1);
  expect(core.postMessage).toHaveBeenCalledTimes(1);
});

test('a worker that cannot start leaves the core connection alone', () => {
  const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
  const core = { postMessage: vi.fn() } satisfies CoreEndpoint;
  const host = createSearchDatabaseHost({
    locks: undefined,
    spawn: () => {
      throw new ReferenceError('Worker is not defined');
    },
    channel: () => new MessageChannel(),
  });

  expect(() => {
    host.attach(core);
  }).not.toThrow();

  expect(core.postMessage).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
  failed.mockRestore();
});
