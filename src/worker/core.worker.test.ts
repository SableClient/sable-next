import { afterEach, expect, test, vi } from 'vitest';
import { defaultStackParser } from '@sentry/sveltekit';
import { applyWasmDebugImage } from '../transport/wasm-debug';
import type { WorkerMessage } from './protocol';

const { setPanicHandler, init } = vi.hoisted(() => ({
  setPanicHandler: vi.fn<(callback: (message: string) => void) => void>(),
  init: vi.fn(() => Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) })),
}));
vi.mock('#src/generated/wasm/sable_wasm.js', () => ({
  default: init,
  SableCore: class {
    subscribeEvents() {}
  },
  setPanicHandler,
  setLogHandler: vi.fn(),
  setSpanHandler: vi.fn(),
  setLogCapture: vi.fn(),
  setLogFilter: vi.fn(),
}));
vi.mock('#src/generated/wasm/sable_wasm_build_id.js', () => ({
  default: {
    code_id: `10${'01'.repeat(16)}`,
    debug_id: `10${'01'.repeat(15)}0`,
  },
}));
vi.mock('#lib/platform/session-storage.js', () => ({}));
vi.mock('./store-ownership', () => ({ claimStore: () => Promise.resolve() }));
vi.mock('./adaptive-fetch', () => ({ installFirefoxFetchLimit: vi.fn() }));
vi.mock('./upload-deadline', () => ({ installUploadDeadline: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('the Rust panic callback captures wasm frames synchronously inside the worker', async () => {
  vi.useFakeTimers();
  const worker = Object.assign(new EventTarget(), {
    location: new URL('https://sable.test/core.worker.js'),
    close: vi.fn(),
    onconnect: null as ((event: { ports: MessagePort[] }) => void) | null,
  });
  vi.stubGlobal('self', worker);
  const compile = vi.spyOn(WebAssembly, 'compileStreaming');
  vi.stubGlobal('fetch', vi.fn());
  await import('./core.worker');
  await vi.waitFor(() => {
    expect(setPanicHandler).toHaveBeenCalledOnce();
  });
  const postMessage = vi.fn();
  worker.onconnect?.({ ports: [{ postMessage, start: vi.fn() } as unknown as MessagePort] });

  const callback = setPanicHandler.mock.calls[0][0];
  // A wasm import keeps the panic callback on a real wasm stack.
  const caller = new WebAssembly.Instance(
    new WebAssembly.Module(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 7, 1, 1, 109, 1, 102, 0, 0, 3, 2, 1, 0,
        7, 7, 1, 3, 114, 117, 110, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11,
      ])
    ),
    {
      m: {
        f: () => {
          callback('Rust panic');
        },
      },
    }
  );
  (caller.exports.run as () => void)();

  const [{ panic }] = postMessage.mock.calls[0] as [Extract<WorkerMessage, { panic: unknown }>];
  expect(panic.message).toBe('Rust panic');
  expect(panic.stack).toContain('wasm-function[1]');
  expect(panic.wasm?.code_file).toContain('sable_wasm_bg.wasm');
  expect(panic.wasm).toMatchObject({
    type: 'wasm',
    code_id: `10${'01'.repeat(16)}`,
    debug_id: `10${'01'.repeat(15)}0`,
  });
  if (!panic.wasm || !panic.stack) throw new Error('missing wasm crash metadata');
  const event = applyWasmDebugImage(
    {
      exception: { values: [{ stacktrace: { frames: defaultStackParser(panic.stack) } }] },
    },
    panic.wasm
  );
  expect(event.exception?.values?.[0].stacktrace?.frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filename: panic.wasm.code_file,
        platform: 'native',
        addr_mode: 'rel:0',
      }),
    ])
  );
  expect(init).toHaveBeenCalledExactlyOnceWith();
  expect(compile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
