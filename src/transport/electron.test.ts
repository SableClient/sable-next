import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../worker/core.worker.ts?sharedworker&url', () => ({ default: 'core.worker.js' }));
vi.mock('#src/generated/wasm/sable_wasm_version.js', () => ({ default: 'test-wasm-version' }));

const { resetWebStorage } = vi.hoisted(() => ({
  resetWebStorage: vi.fn<(accountIds: readonly string[]) => Promise<void>>(),
}));
vi.mock('#lib/platform/session-storage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/session-storage.js')>()),
  resetWebStorage,
}));
vi.mock('@sentry/sveltekit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/sveltekit')>()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

class FakeWindow extends EventTarget {
  location = { origin: 'sable-app://app', search: '' };
  connections: MessagePort[] = [];

  postMessage(message: unknown, _origin: string, transfer: Transferable[] = []): void {
    if (message === 'sable-core-connect') this.connections.push(transfer[0] as MessagePort);
  }

  coreExited(message: string): void {
    this.dispatchEvent(
      Object.assign(new Event('message'), { data: { sableCoreExit: message }, source: this })
    );
  }
}

function serve(port: MessagePort): void {
  port.onmessage = ({ data }: MessageEvent<{ id: number; call?: { method: string } }>) => {
    if (data.call) port.postMessage({ id: data.id, ok: data.call.method });
  };
}

let fakeWindow: FakeWindow;

beforeEach(() => {
  fakeWindow = new FakeWindow();
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('self', fakeWindow);
});

afterEach(() => {
  for (const port of fakeWindow.connections) port.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('calls reach the core over the port the page hands to the preload', async () => {
  const { createElectronTransport } = await import('./electron');
  const transport = createElectronTransport();

  const reply = transport.call('session.restore', {});
  await vi.waitFor(() => {
    expect(fakeWindow.connections).toHaveLength(1);
  });
  serve(fakeWindow.connections[0]);

  await expect(reply).resolves.toBe('session.restore');
  transport.close();
});

test('a core that exits rejects what is pending and the next call reconnects', async () => {
  const { createElectronTransport } = await import('./electron');
  const transport = createElectronTransport();
  const crashes: string[] = [];
  transport.subscribeCrash((message) => crashes.push(message));

  const pending = transport.call('session.restore', {});
  await vi.waitFor(() => {
    expect(fakeWindow.connections).toHaveLength(1);
  });
  fakeWindow.coreExited('index out of bounds');

  await expect(pending).rejects.toMatchObject({
    detail: { code: 'failed', log_id: 'core panicked: index out of bounds' },
  });
  expect(crashes).toEqual(['index out of bounds']);

  const retried = transport.call('session.restore', {});
  await vi.waitFor(() => {
    expect(fakeWindow.connections).toHaveLength(2);
  });
  serve(fakeWindow.connections[1]);
  await expect(retried).resolves.toBe('session.restore');
  transport.close();
});

test('uploads copy their bytes, since a transferred buffer never reaches the core', async () => {
  const { createElectronTransport } = await import('./electron');
  const transport = createElectronTransport();
  const bytes = new Uint8Array([137, 80, 78, 71]);

  const upload = transport.uploadMedia('image/png', bytes);
  await vi.waitFor(() => {
    expect(fakeWindow.connections).toHaveLength(1);
  });
  const port = fakeWindow.connections[0];
  port.onmessage = ({ data }: MessageEvent<{ id: number; upload?: unknown }>) => {
    if (data.upload) port.postMessage({ id: data.id, uri: 'mxc://example.org/media' });
  };

  await expect(upload).resolves.toBe('mxc://example.org/media');
  expect(bytes.byteLength).toBe(4);
  transport.close();
});

test('resetCaches asks the native core to drop its cache, then clears web storage', async () => {
  const { createElectronTransport } = await import('./electron');
  const transport = createElectronTransport();

  const reset = transport.resetCaches(['@alice:example.org']);
  await vi.waitFor(() => {
    expect(fakeWindow.connections).toHaveLength(1);
  });
  const port = fakeWindow.connections[0];
  const methods: string[] = [];
  port.onmessage = ({ data }: MessageEvent<{ id: number; call?: { method: string } }>) => {
    if (!data.call) return;
    methods.push(data.call.method);
    port.postMessage({ id: data.id, ok: null });
  };

  await reset;
  expect(methods).toEqual(['session.reset_local_cache']);
  expect(resetWebStorage).toHaveBeenCalledWith(['@alice:example.org']);
  transport.close();
});
