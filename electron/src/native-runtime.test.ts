import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent, Batch, Subscribed } from '../../src/generated/protocol.ts';

interface NativeApp {
  handshake(): string;
  open(tab: number): Promise<void>;
  subscribe(tab: number, request: string): Promise<string>;
  dispatch(target: string, action: string): Promise<void>;
  request(tab: number, target: string, action: string): Promise<number>;
  shutdown(): Promise<void>;
}

interface Native {
  SableCore: new (dataDir: string, logFilter: string | null) => object;
  SableApp: new (
    core: object,
    dataDir: string,
    send: (batch: [tab: number, json: string]) => void
  ) => NativeApp;
}

// The library of `cargo build -p sable-node --features demo`, which has the `counter` slice.
const library = process.env.SABLE_NODE_LIBRARY;

const counter = JSON.stringify({ slice: 'counter', key: null });

function load(path: string): Native {
  const module = { exports: {} as Native };
  process.dlopen(module, path);
  return module.exports;
}

describe.skipIf(!library)('the native runtime', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function start(dir: string) {
    const native = load(library as string);
    const sent: { tab: number; events: AppEvent[] }[] = [];
    const app = new native.SableApp(new native.SableCore(dir, null), dir, ([tab, batch]) => {
      sent.push({ tab, events: (JSON.parse(batch) as Batch).events });
    });
    await app.open(1);
    const next = (type: AppEvent['type']) =>
      vi.waitFor(() => {
        const found = sent.flatMap(({ events }) => events).find((event) => event.type === type);
        expect(found).toBeDefined();
        return found as AppEvent;
      });
    return { app, sent, next };
  }

  it('serves a slice through the napi surface, with patches, replies and rejections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sable-node-'));
    dirs.push(dir);
    const { app, sent, next } = await start(dir);
    await app.open(2);

    expect(JSON.parse(app.handshake())).toMatchObject({ slices: ['counter'] });
    await expect(app.subscribe(1, '{"slice":"nope","key":null}')).rejects.toThrow('unknown_slice');

    const { sub, snapshot } = JSON.parse(await app.subscribe(1, counter)) as Subscribed;
    expect(snapshot.state).toEqual({ count: 0 });

    await app.dispatch(counter, JSON.stringify({ type: 'add', n: 3 }));
    expect(await next('patch')).toMatchObject({ sub, rev: 1 });

    const req = await app.request(1, counter, JSON.stringify({ type: 'double' }));
    expect(await next('reply')).toMatchObject({
      req,
      outcome: { status: 'ok', value: 6 },
    });
    expect(sent.every(({ tab }) => tab === 1)).toBe(true);
    await app.shutdown();
  });

  it('saves a view in the data directory as it stops and starts the next run from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sable-node-'));
    dirs.push(dir);
    const first = await start(dir);
    await first.app.subscribe(1, counter);
    await first.app.dispatch(counter, JSON.stringify({ type: 'add', n: 4 }));
    await first.app.shutdown();
    expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(1);

    const second = await start(dir);
    const { snapshot } = JSON.parse(await second.app.subscribe(1, counter)) as Subscribed;

    expect(snapshot.state).toEqual({ count: 4 });
  });
});
