import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppMessage, AppRequest } from '#src/worker/app-protocol';
import type { CoreConnection } from './web';
import { createWebLink } from './web-runtime';

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function fakeWorker() {
  const workers: {
    port: MessagePort;
    requests: AppRequest[];
    send(message: AppMessage): void;
  }[] = [];
  const retired = vi.fn();
  const open = (): CoreConnection => {
    return {
      port: {
        postMessage: (message: { runtime?: true }, transfer?: MessagePort[]) => {
          if (message.runtime && transfer) {
            const [port] = transfer;
            const requests: AppRequest[] = [];
            port.onmessage = ({ data }: MessageEvent<AppRequest>) => {
              requests.push(data);
              if ('id' in data && data.op === 'handshake') {
                port.postMessage({ id: data.id, ok: { schema: 's', slices: [] } });
              }
            };
            workers.push({
              port,
              requests,
              send: (reply) => {
                port.postMessage(reply);
              },
            });
          }
        },
        close: () => undefined,
      } as unknown as MessagePort,
      onFailure: () => undefined,
      retire: retired,
    };
  };
  return { open, workers, retired };
}

const lockRequest = vi.fn(() => new Promise(() => undefined));

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebLink', () => {
  it('says hello with the tab it holds a lock for, then answers calls', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);

    expect(await link.handshake()).toEqual({ schema: 's', slices: [] });

    const [hello] = workers[0].requests;
    expect(hello).toMatchObject({ op: 'hello' });
    expect(lockRequest).toHaveBeenCalledWith(
      `sable-runtime-tab-${(hello as { tab: string }).tab}`,
      expect.any(Function)
    );
  });

  it('passes on the batches of its worker', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);
    const heard = vi.fn();
    link.onBatch(heard);

    workers[0].send({ batch: { tick: 3, events: [] } });
    await flush();

    expect(heard).toHaveBeenCalledWith({ tick: 3, events: [] });
  });

  it('rejects what the worker answers with an error', async () => {
    const { open, workers } = fakeWorker();
    const link = createWebLink(open);
    const pending = link.unsubscribe(4);
    await flush();
    const request = workers[0].requests.at(-1) as { id: number };

    workers[0].send({ id: request.id, error: 'unknown_sub' });

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
});
