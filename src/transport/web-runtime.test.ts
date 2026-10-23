import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expose } from 'comlink';

import type { AppMessage, AppRemote, AppRequest } from '#src/worker/app-protocol';
import { createWebLink, type RuntimeConnection } from './web-runtime';

const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const ports: MessagePort[] = [];
type Hello = (tab: string) => void;

function fakeWorker() {
  const workers: {
    port: MessagePort;
    api: AppRemote;
    hello: Hello;
    send(message: AppMessage): void;
  }[] = [];
  const retired = vi.fn();
  const failures: ((message: string) => void)[] = [];
  const open = (): RuntimeConnection => ({
    handOver: (port) => {
      ports.push(port);
      const api: AppRemote = {
        handshake: vi.fn(() => Promise.resolve({ schema: 's', slices: [] })),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(() => Promise.reject(new Error('unknown_sub'))),
        resync: vi.fn<AppRemote['resync']>(() => new Promise(() => {})),
        range: vi.fn(),
        dispatch: vi.fn(),
        request: vi.fn(),
      };
      const hello = vi.fn<Hello>();
      port.onmessage = ({ data }: MessageEvent<AppRequest>) => {
        if (data.op === 'hello') hello(data.tab);
      };
      expose(api, port);
      workers.push({
        port,
        api,
        hello,
        send: (reply) => {
          port.postMessage(reply);
        },
      });
    },
    onFailure: (handler) => {
      failures.push(handler);
    },
    retire: retired,
  });
  return { open, workers, retired, failures };
}

const lockRequest = vi.fn((_name: string, own: () => Promise<never>) => own());

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
});

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.unstubAllGlobals();
});

describe('createWebLink', () => {
  it('says hello with the tab it holds a lock for, then answers calls', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);

    expect(await link.handshake()).toEqual({ schema: 's', slices: [] });

    const [tab] = vi.mocked(workers[0].hello).mock.calls[0];
    expect(lockRequest).toHaveBeenCalledWith(`sable-runtime-tab-${tab}`, expect.any(Function));
  });

  it('waits for the tab lock before connecting the worker', async () => {
    const owned = Promise.withResolvers<undefined>();
    lockRequest.mockImplementationOnce(async (_name, own) => {
      await owned.promise;
      return own();
    });
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);
    const handshaking = link.handshake();
    try {
      await flush();
      expect(workers.length).toBe(0);
    } finally {
      owned.resolve(undefined);
    }

    expect(await handshaking).toEqual({ schema: 's', slices: [] });
    expect(workers[0].hello).toHaveBeenCalledOnce();
  });

  it('passes on the batches of its worker', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);
    const heard = vi.fn();
    link.onBatch(heard);

    await link.handshake();
    workers[0].send({ batch: { tick: 3, events: [] } });
    await flush();

    expect(heard).toHaveBeenCalledWith({ tick: 3, events: [] });
  });

  it('rejects what the worker answers with an error', async () => {
    const { open } = fakeWorker();
    const link = createWebLink(open);
    const pending = link.unsubscribe(4);
    await expect(pending).rejects.toThrow('unknown_sub');
  });

  it('opens the next worker when the worker panics, and tells the client', async () => {
    const { open, workers, retired } = fakeWorker();
    const link = createWebLink(open);
    const restarted = vi.fn();
    link.onRestart?.(restarted);
    const pending = link.resync(1);
    pending.catch(() => undefined);
    await flush();

    workers[0].send({ crashed: true });
    await flush();

    expect(retired).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    expect(restarted).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow('the worker restarted');
    expect(await link.handshake()).toEqual({ schema: 's', slices: [] });
  });

  it('restarts when the process behind the link fails to run', async () => {
    const { open, workers, failures } = fakeWorker();
    const link = createWebLink(open);
    const restarted = vi.fn();
    link.onRestart?.(restarted);

    failures[0]('core exited with code 1');
    failures[0]('core exited with code 1');
    await flush();

    expect(workers).toHaveLength(2);
    expect(restarted).toHaveBeenCalledTimes(1);
  });

  it('gives up on a worker that keeps panicking before a handshake', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);

    for (let crashes = 0; crashes < 4; crashes++) {
      workers.at(-1)?.send({ crashed: true });
      await flush();
    }

    expect(workers).toHaveLength(4);
    await expect(link.handshake()).rejects.toThrow('keeps crashing');
  });

  it('stops asking a worker that a newer tab superseded', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);
    const pending = link.resync(1);
    pending.catch(() => undefined);
    await flush();

    workers[0].send({ superseded: true });
    await flush();

    await expect(pending).rejects.toThrow('a newer tab took over');
    await expect(link.resync(1)).rejects.toThrow('a newer tab took over');
  });

  it('ignores notifications and failure callbacks from a retired generation', async () => {
    const { open, workers, failures } = fakeWorker();
    const link = createWebLink(open);
    const heard = vi.fn();
    link.onBatch(heard);
    await link.handshake();
    const oldHandler = workers[0].port;
    failures[0]('exited');
    failures[0]('exited again');
    oldHandler.postMessage({ batch: { tick: 99, events: [] } });
    await link.handshake();
    expect(workers).toHaveLength(2);
    expect(heard).not.toHaveBeenCalled();
  });
});
