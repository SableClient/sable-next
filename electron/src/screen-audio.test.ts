import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  load: vi.fn(),
  link: vi.fn(() => true),
  unlink: vi.fn(),
  unmute: vi.fn(),
}));
const windows = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./windows-screen-audio', () => windows);
const fox = vi.hoisted(() => ({
  available: true,
  listApps: vi.fn(() => ({ apps: [], status: 'available' })),
  start: vi.fn(),
  stop: vi.fn(),
  sourceName: (id: string) =>
    id.startsWith('audiofox:') ? id.slice('audiofox:'.length) : undefined,
}));
vi.mock('./audiofox', () => fox);
vi.mock('electron', () => ({ app: { getAppMetrics: () => [{ name: 'Audio Service', pid: 42 }] } }));
vi.mock('node:module', () => ({ createRequire: () => native.load }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.stubGlobal('__dirname', '/native');
  native.link.mockReturnValue(true);
  fox.available = true;
  fox.listApps.mockReturnValue({ apps: [], status: 'available' });
  native.load.mockImplementation(() => ({
    PatchBay: class {
      link = native.link;
      unlink = native.unlink;
      unmute = native.unmute;
    },
  }));
});

afterEach(() => vi.unstubAllGlobals());

test('keeps Windows system audio on its existing backend', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const audio = await import('./screen-audio');
  const frames = vi.fn();
  const selection = { kind: 'system', exclude: [] };
  await audio.startStream(selection, frames);
  expect(windows.start).toHaveBeenCalledWith(selection, frames);
  expect(windows.stop).toHaveBeenCalledOnce();
});

test('reports Audiofox enumeration and runtime failures', async () => {
  const audio = await import('./screen-audio');
  fox.listApps.mockImplementationOnce(() => {
    throw new Error('missing addon');
  });
  expect(await audio.listApps()).toEqual({ apps: [], status: 'unavailable' });
  fox.listApps.mockImplementationOnce(() => {
    throw new Error('GLIBC_2.38 not found');
  });
  expect((await audio.listApps()).status).toBe('incompatible');
});

test('application sharing uses Audiofox without loading Venmic', async () => {
  const audio = await import('./screen-audio');
  const frames = vi.fn();
  await audio.startStream({ kind: 'apps', include: ['audiofox:music'] }, frames);
  expect(fox.start).toHaveBeenCalledWith(['audiofox:music'], frames);
  expect(native.load).not.toHaveBeenCalled();
});

test('starts muted and ignores unmute after stopping', async () => {
  const audio = await import('./screen-audio');
  audio.start({ kind: 'system', exclude: ['Spotify'] });
  expect(native.link).toHaveBeenCalledWith({
    mute: true,
    include: [{ 'media.class': 'Stream/Output/Audio' }],
    exclude: [{ 'application.process.id': '42' }, { 'application.name': 'Spotify' }],
    workaround: [],
  });
  expect(native.unmute).not.toHaveBeenCalled();
  audio.unmute();
  expect(native.unmute).toHaveBeenCalledOnce();
  audio.stop();
  audio.unmute();
  expect(native.unmute).toHaveBeenCalledOnce();
  expect(native.unlink).toHaveBeenCalledOnce();
});

test('enables the microphone workaround only when requested', async () => {
  const audio = await import('./screen-audio');
  audio.start({ kind: 'system', exclude: [], workaround: true });
  expect(native.link).toHaveBeenCalledWith(
    expect.objectContaining({
      workaround: [{ 'application.process.id': '42', 'media.name': 'RecordStream' }],
    })
  );
});

test('uses Audiofox names for system exclusions and rejects malformed legacy sources', async () => {
  const audio = await import('./screen-audio');
  audio.start({ kind: 'system', exclude: ['audiofox:music'] });
  expect(native.link).toHaveBeenCalledWith({
    include: [{ 'media.class': 'Stream/Output/Audio' }],
    exclude: [{ 'application.process.id': '42' }, { 'node.name': 'music' }],
    mute: true,
    workaround: [],
  });
  expect(() => audio.start({ kind: 'system', exclude: ['pipewire:{}'] })).toThrow(
    'invalid audio source'
  );
});

test('cleans up a failed link without unmuting it', async () => {
  native.link.mockReturnValue(false);
  const audio = await import('./screen-audio');
  expect(() => audio.start({ kind: 'system', exclude: [] })).toThrow(
    'screen audio could not be linked'
  );
  expect(native.unlink).toHaveBeenCalledOnce();
  audio.unmute();
  expect(native.unmute).not.toHaveBeenCalled();
});
