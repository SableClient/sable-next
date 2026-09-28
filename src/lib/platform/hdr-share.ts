import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { type as osType } from '@tauri-apps/plugin-os';

export interface HdrMonitor {
  index: number;
  name: string;
  hdr: boolean;
}

interface SlotData {
  generation: number;
  slot: number;
  width: number;
  height: number;
}

interface SharedBufferEvent extends Event {
  additionalData?: { sableHdr?: SlotData };
  getBuffer: () => ArrayBuffer;
}

interface WebView2Bridge {
  addEventListener: (
    type: 'sharedbufferreceived',
    listener: (event: SharedBufferEvent) => void
  ) => void;
  removeEventListener: (
    type: 'sharedbufferreceived',
    listener: (event: SharedBufferEvent) => void
  ) => void;
}

interface VideoGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}

type GeneratorConstructor = new (init: { kind: 'video' }) => VideoGenerator;

function bridge(): WebView2Bridge | undefined {
  return (window as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
}

function generatorConstructor(): GeneratorConstructor | undefined {
  return (window as { MediaStreamTrackGenerator?: GeneratorConstructor }).MediaStreamTrackGenerator;
}

export function hdrShareSupported(): boolean {
  return (
    isTauri() &&
    osType() === 'windows' &&
    bridge() !== undefined &&
    generatorConstructor() !== undefined &&
    typeof VideoFrame !== 'undefined'
  );
}

export async function listHdrMonitors(): Promise<HdrMonitor[]> {
  const monitors = await invoke<HdrMonitor[]>('hdr_monitors');
  return monitors.filter((monitor) => monitor.hdr);
}

let active: { stop: () => Promise<void> } | null = null;

/** Captures monitor `index` through the desktop app's HDR-to-SDR path and
    returns it as a video track the page can publish like any screen share. */
export async function startHdrShare(index: number): Promise<MediaStreamTrack> {
  await stopHdrShare();
  const webview = bridge();
  const Generator = generatorConstructor();
  if (!webview || !Generator) throw new Error('hdr share unsupported');

  const buffers = new Map<number, ArrayBuffer>();
  let generation = -1;
  const onBuffer = (event: SharedBufferEvent): void => {
    const data = event.additionalData?.sableHdr;
    if (!data) return;
    if (data.generation !== generation) {
      buffers.clear();
      generation = data.generation;
    }
    buffers.set(data.slot, event.getBuffer());
  };
  webview.addEventListener('sharedbufferreceived', onBuffer);

  const generator = new Generator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const unlisten: UnlistenFn = await listen<SlotData>('hdr-frame', ({ payload }) => {
    const buffer = buffers.get(payload.slot);
    try {
      if (!buffer || payload.generation !== generation) return;
      const frame = new VideoFrame(new Uint8Array(buffer, 0, payload.width * payload.height * 4), {
        format: 'BGRX',
        codedWidth: payload.width,
        codedHeight: payload.height,
        timestamp: Math.round(performance.now() * 1000),
      });
      void writer.write(frame).catch(() => {
        frame.close();
      });
    } finally {
      void invoke('hdr_frame_done', { slot: payload.slot });
    }
  });

  const stop = async (): Promise<void> => {
    unlisten();
    webview.removeEventListener('sharedbufferreceived', onBuffer);
    buffers.clear();
    await writer.close().catch(() => undefined);
    await invoke('stop_hdr_share');
  };
  active = { stop };
  generator.addEventListener('ended', () => {
    if (active?.stop === stop) void stopHdrShare();
  });

  try {
    await invoke('start_hdr_share', { index });
  } catch (error) {
    await stopHdrShare();
    throw error;
  }
  return generator;
}

export async function stopHdrShare(): Promise<void> {
  const current = active;
  active = null;
  await current?.stop();
}
