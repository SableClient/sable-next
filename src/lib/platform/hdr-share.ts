import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
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
  if (!isTauri() || generatorConstructor() === undefined || typeof VideoFrame === 'undefined') {
    return false;
  }
  const os = osType();
  return (os === 'windows' && bridge() !== undefined) || os === 'linux';
}

export function hdrSharePicksMonitor(): boolean {
  return osType() === 'linux';
}

export async function listHdrMonitors(): Promise<HdrMonitor[]> {
  const monitors = await invoke<HdrMonitor[]>('hdr_monitors');
  return monitors.filter((monitor) => monitor.hdr);
}

let active: { stop: () => Promise<void> } | null = null;

function frameFrom(data: ArrayBuffer, offset: number, width: number, height: number): VideoFrame {
  return new VideoFrame(new Uint8Array(data, offset, width * height * 4), {
    format: 'BGRX',
    codedWidth: width,
    codedHeight: height,
    timestamp: Math.round(performance.now() * 1000),
  });
}

function writeFrame(writer: WritableStreamDefaultWriter<VideoFrame>, frame: VideoFrame): void {
  void writer.write(frame).catch(() => {
    frame.close();
  });
}

/** Captures monitor `index` through the desktop app's HDR-to-SDR path and
    returns it as a video track the page can publish like any screen share. */
export async function startHdrShare(
  index: number,
  onEnded: () => void = () => undefined
): Promise<MediaStreamTrack> {
  await stopHdrShare();
  const Generator = generatorConstructor();
  if (!Generator) throw new Error('hdr share unsupported');
  return osType() === 'linux'
    ? startPortalShare(Generator, onEnded)
    : startWindowsShare(Generator, index);
}

async function startPortalShare(
  Generator: GeneratorConstructor,
  onEnded: () => void
): Promise<MediaStreamTrack> {
  const generator = new Generator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const frames = new Channel<ArrayBuffer>();
  const stop = async (): Promise<void> => {
    frames.onmessage = () => undefined;
    await writer.close().catch(() => undefined);
    await invoke('stop_hdr_share');
  };
  frames.onmessage = (data) => {
    if (data.byteLength === 0) {
      if (active?.stop === stop) onEnded();
      return;
    }
    try {
      const header = new DataView(data, 0, 8);
      writeFrame(writer, frameFrom(data, 8, header.getUint32(0, true), header.getUint32(4, true)));
    } catch (error) {
      console.warn('[sable hdr] dropped a frame', error);
    } finally {
      void invoke('hdr_frame_done');
    }
  };
  active = { stop };

  try {
    await invoke('start_hdr_share', { frames });
  } catch (error) {
    await stopHdrShare();
    throw error;
  }
  return generator;
}

async function startWindowsShare(
  Generator: GeneratorConstructor,
  index: number
): Promise<MediaStreamTrack> {
  const webview = bridge();
  if (!webview) throw new Error('hdr share unsupported');

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
      writeFrame(writer, frameFrom(buffer, 0, payload.width, payload.height));
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
