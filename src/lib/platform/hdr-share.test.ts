// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(() =>
    Promise.resolve(undefined)
  ),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: () => true,
  Channel: class {
    onmessage: (data: ArrayBuffer) => void = () => undefined;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.listeners.set(name, handler);
    return Promise.resolve(() => tauri.listeners.delete(name));
  },
}));
const os = vi.hoisted(() => ({ type: vi.fn(() => 'windows') }));
vi.mock('@tauri-apps/plugin-os', () => os);

import { hdrShareSupported, startHdrShare, stopHdrShare } from './hdr-share';

type BufferListener = (event: { additionalData?: unknown; getBuffer: () => ArrayBuffer }) => void;

let bufferListener: BufferListener | undefined;
const written: { init: { codedWidth: number; codedHeight: number } }[] = [];

beforeEach(() => {
  written.length = 0;
  tauri.invoke.mockClear();
  vi.stubGlobal('chrome', {
    webview: {
      addEventListener: (_: string, listener: BufferListener) => {
        bufferListener = listener;
      },
      removeEventListener: () => {
        bufferListener = undefined;
      },
    },
  });
  vi.stubGlobal(
    'VideoFrame',
    class {
      constructor(
        readonly data: Uint8Array,
        readonly init: { codedWidth: number; codedHeight: number }
      ) {}
      close() {}
    }
  );
  vi.stubGlobal(
    'MediaStreamTrackGenerator',
    class extends EventTarget {
      writable = new WritableStream({
        write: (frame: { init: { codedWidth: number; codedHeight: number } }) => {
          written.push(frame);
        },
      });
    }
  );
});

afterEach(async () => {
  await stopHdrShare();
  vi.unstubAllGlobals();
});

function announce(slot: number, generation: number): void {
  tauri.listeners.get('hdr-frame')?.({ payload: { slot, width: 2, height: 1, generation } });
}

test('is available only with the WebView2 bridge and a track generator', () => {
  expect(hdrShareSupported()).toBe(true);
  vi.stubGlobal('chrome', undefined);
  expect(hdrShareSupported()).toBe(false);
});

test('an announced slot becomes a video frame and is handed back', async () => {
  await startHdrShare(1);
  expect(tauri.invoke).toHaveBeenCalledWith('start_hdr_share', { index: 1 });

  bufferListener?.({
    additionalData: { sableHdr: { generation: 1, slot: 0, width: 2, height: 1 } },
    getBuffer: () => new ArrayBuffer(8),
  });
  announce(0, 1);
  await vi.waitFor(() => {
    expect(written).toHaveLength(1);
  });

  expect(written[0]?.init).toMatchObject({ codedWidth: 2, codedHeight: 1 });
  expect(tauri.invoke).toHaveBeenCalledWith('hdr_frame_done', { slot: 0 });
});

test('a frame from an older ring is dropped but its slot is still released', async () => {
  await startHdrShare(0);
  bufferListener?.({
    additionalData: { sableHdr: { generation: 2, slot: 1, width: 2, height: 1 } },
    getBuffer: () => new ArrayBuffer(8),
  });

  announce(1, 1);

  expect(tauri.invoke).toHaveBeenCalledWith('hdr_frame_done', { slot: 1 });
  expect(written).toHaveLength(0);
});

test('stopping tells the desktop app to stop capturing', async () => {
  await startHdrShare(0);
  await stopHdrShare();
  expect(tauri.invoke).toHaveBeenCalledWith('stop_hdr_share');
  expect(tauri.listeners.has('hdr-frame')).toBe(false);
});

function portalFrames(): (data: ArrayBuffer) => void {
  const call = tauri.invoke.mock.calls.find(([command]) => command === 'start_hdr_share');
  const args = call?.[1] as { frames: { onmessage: (data: ArrayBuffer) => void } } | undefined;
  return (data) => {
    args?.frames.onmessage(data);
  };
}

test('on Linux a channel frame becomes a video frame and is handed back', async () => {
  os.type.mockReturnValue('linux');
  vi.stubGlobal('chrome', undefined);
  expect(hdrShareSupported()).toBe(true);

  await startHdrShare(0);
  const frame = new ArrayBuffer(16);
  new DataView(frame).setUint32(0, 2, true);
  new DataView(frame).setUint32(4, 1, true);
  portalFrames()(frame);

  await vi.waitFor(() => {
    expect(written).toHaveLength(1);
  });
  expect(written[0]?.init).toMatchObject({ codedWidth: 2, codedHeight: 1 });
  expect(tauri.invoke).toHaveBeenCalledWith('hdr_frame_done');
  os.type.mockReturnValue('windows');
});

test('on Linux an empty message means the desktop ended the capture', async () => {
  os.type.mockReturnValue('linux');
  const ended = vi.fn();

  await startHdrShare(0, ended);
  portalFrames()(new ArrayBuffer(0));

  expect(ended).toHaveBeenCalledOnce();
  expect(tauri.invoke).not.toHaveBeenCalledWith('hdr_frame_done');
  os.type.mockReturnValue('windows');
});

test.each(['windows', 'linux'])(
  'scales %s HDR frames to the selected resolution',
  async (platform) => {
    os.type.mockReturnValue(platform);
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number
        ) {}
        getContext() {
          return { drawImage };
        }
      }
    );
    vi.stubGlobal(
      'VideoFrame',
      class {
        readonly init: { codedWidth: number; codedHeight: number };
        constructor(
          data: { width?: number; height?: number },
          init: { codedWidth?: number; codedHeight?: number }
        ) {
          this.init = {
            codedWidth: init.codedWidth ?? data.width ?? 0,
            codedHeight: init.codedHeight ?? data.height ?? 0,
          };
        }
        close = close;
      }
    );
    try {
      await startHdrShare(0, undefined, { width: 640, height: 360 });
      const width = 1920;
      const height = 1200;
      if (platform === 'linux') {
        const frame = new ArrayBuffer(8 + width * height * 4);
        new DataView(frame).setUint32(0, width, true);
        new DataView(frame).setUint32(4, height, true);
        portalFrames()(frame);
      } else {
        bufferListener?.({
          additionalData: { sableHdr: { generation: 1, slot: 0, width, height } },
          getBuffer: () => new ArrayBuffer(width * height * 4),
        });
        tauri.listeners.get('hdr-frame')?.({ payload: { generation: 1, slot: 0, width, height } });
      }
      await vi.waitFor(() => {
        expect(written).toHaveLength(1);
      });
      expect(written[0]?.init).toEqual({ codedWidth: 576, codedHeight: 360 });
      expect(drawImage).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      os.type.mockReturnValue('windows');
    }
  }
);
