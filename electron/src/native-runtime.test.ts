import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEvent, Batch, Subscribed } from '../../src/generated/protocol.ts';

/** The napi surface under test, as `core-host.ts` uses it. */
interface NativeApp {
  handshake(): string;
  subscribe(request: string): Promise<string>;
  dispatch(target: string, action: string): Promise<void>;
  request(target: string, action: string): Promise<number>;
  nextBatch(): Promise<string>;
  shutdown(): Promise<void>;
}

interface Native {
  SableCore: new (dataDir: string, logFilter: string | null) => object;
  SableApp: new (core: object, dataDir: string) => NativeApp;
}

// The library of `cargo build -p sable-node --features demo`, which has the `counter` slice.
const library = process.env.SABLE_NODE_LIBRARY;

const counter = JSON.stringify({ slice: 'counter', key: null });

function load(path: string): Native {
  const module = { exports: {} as Native };
  process.dlopen(module, path);
  return module.exports;
}

async function next(app: NativeApp, type: AppEvent['type']): Promise<AppEvent> {
  for (;;) {
    const { events } = JSON.parse(await app.nextBatch()) as Batch;
    const found = events.find((event) => event.type === type);
    if (found) return found;
  }
}

describe.skipIf(!library)('the native runtime', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function start(dir: string) {
    const native = load(library as string);
    return new native.SableApp(new native.SableCore(dir, null), dir);
  }

  it('serves a slice through the napi surface, with patches, replies and rejections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sable-node-'));
    dirs.push(dir);
    const app = start(dir);

    expect(JSON.parse(app.handshake())).toMatchObject({ slices: ['counter'] });
    await expect(app.subscribe('{"slice":"nope","key":null}')).rejects.toThrow('unknown_slice');

    const { sub, snapshot } = JSON.parse(
      await app.subscribe(JSON.stringify({ slice: 'counter', key: null }))
    ) as Subscribed;
    expect(snapshot.state).toEqual({ count: 0 });

    await app.dispatch(counter, JSON.stringify({ type: 'add', n: 3 }));
    expect(await next(app, 'patch')).toMatchObject({ sub, rev: 1 });

    const req = await app.request(counter, JSON.stringify({ type: 'double' }));
    expect(await next(app, 'reply')).toMatchObject({
      req,
      outcome: { status: 'ok', value: 6 },
    });
    await app.shutdown();
  });

  it('saves a view in the data directory as it stops and starts the next run from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sable-node-'));
    dirs.push(dir);
    const first = start(dir);
    await first.subscribe(counter);
    await first.dispatch(counter, JSON.stringify({ type: 'add', n: 4 }));
    await first.shutdown();
    expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(1);

    const second = start(dir);
    const { snapshot } = JSON.parse(await second.subscribe(counter)) as Subscribed;

    expect(snapshot.state).toEqual({ count: 4 });
  });
});
