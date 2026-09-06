import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  fileNameFromPath,
  filtersFor,
  mimeFromName,
  pickFiles,
  saveFile,
  saveImageToPhotos,
  savesNatively,
  shareFile,
  sharesNatively,
} from './files';

const mocks = vi.hoisted(() => ({
  androidFs: {
    createNewPublicFile: vi.fn(),
    createNewPublicImageFile: vi.fn(),
    getMetadata: vi.fn(),
    PublicGeneralPurposeDir: { Download: 'Download' },
    PublicImageDir: { Pictures: 'Pictures' },
    readFile: vi.fn(),
    removeFile: vi.fn(),
    scanPublicFile: vi.fn(),
    setPublicFilePending: vi.fn(),
    showOpenFilePicker: vi.fn(),
    writeFile: vi.fn(),
  },
  dialogOpen: vi.fn(),
  fsReadFile: vi.fn(),
  fsRemove: vi.fn(),
  isTauri: vi.fn(),
  invoke: vi.fn(),
  osType: vi.fn(),
  fsWriteFile: vi.fn(),
  appCacheDir: vi.fn(),
  shareNative: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.dialogOpen }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: mocks.fsReadFile,
  remove: mocks.fsRemove,
  writeFile: mocks.fsWriteFile,
}));
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: mocks.appCacheDir,
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}));
vi.mock('@choochmeque/tauri-plugin-sharekit-api', () => ({ shareFile: mocks.shareNative }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }));
vi.mock('tauri-plugin-android-fs-api', () => mocks.androidFs);

beforeEach(() => {
  mocks.isTauri.mockReturnValue(false);
  mocks.osType.mockReturnValue('linux');
  mocks.dialogOpen.mockReset();
  mocks.fsReadFile.mockReset();
  mocks.fsRemove.mockReset();
  mocks.invoke.mockReset();
  mocks.androidFs.createNewPublicFile.mockReset();
  mocks.androidFs.createNewPublicImageFile.mockReset();
  mocks.androidFs.showOpenFilePicker.mockReset();
  mocks.androidFs.getMetadata.mockReset();
  mocks.androidFs.readFile.mockReset();
  mocks.androidFs.removeFile.mockReset();
  mocks.androidFs.scanPublicFile.mockReset();
  mocks.androidFs.setPublicFilePending.mockReset();
  mocks.androidFs.writeFile.mockReset();
  mocks.androidFs.createNewPublicFile.mockResolvedValue({ uri: 'content://downloads/file' });
  mocks.androidFs.createNewPublicImageFile.mockResolvedValue({ uri: 'content://pictures/file' });
  mocks.androidFs.writeFile.mockResolvedValue(undefined);
  mocks.androidFs.setPublicFilePending.mockResolvedValue(undefined);
  mocks.androidFs.scanPublicFile.mockResolvedValue(undefined);
  mocks.fsWriteFile.mockReset();
  mocks.fsWriteFile.mockResolvedValue(undefined);
  mocks.appCacheDir.mockResolvedValue('/cache');
  mocks.shareNative.mockReset();
  mocks.shareNative.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the web build keeps the browser download, having no native dialog', () => {
  expect(savesNatively()).toBe(false);
});

test('a picked path yields its basename on either separator', () => {
  expect(fileNameFromPath('/home/erwan/holiday.png', 0)).toBe('holiday.png');
  expect(fileNameFromPath('C:\\Users\\erwan\\holiday.png', 0)).toBe('holiday.png');
});

test('a path with no basename still names the attachment', () => {
  expect(fileNameFromPath('/', 2)).toBe('attachment-3');
});

test('the media type comes from the extension, which the path does not carry', () => {
  expect(mimeFromName('holiday.PNG')).toBe('image/png');
  expect(mimeFromName('clip.mov')).toBe('video/quicktime');
});

test('an unknown or absent extension falls back to a generic type', () => {
  expect(mimeFromName('archive.zzz')).toBe('application/octet-stream');
  expect(mimeFromName('README')).toBe('application/octet-stream');
});

test('a wildcard accept expands to every extension of that type', () => {
  const filters = filtersFor('image/*');
  expect(filters).toHaveLength(1);
  expect(filters?.[0].extensions).toContain('png');
  expect(filters?.[0].extensions).toContain('webp');
  expect(filters?.[0].extensions).not.toContain('mp4');
});

test('an exact accept matches only that type', () => {
  expect(filtersFor('application/pdf')?.[0].extensions).toEqual(['pdf']);
});

test('accepting anything leaves the dialog unfiltered', () => {
  expect(filtersFor('*/*')).toBeUndefined();
  expect(filtersFor('*')).toBeUndefined();
  expect(filtersFor('')).toBeUndefined();
});

test('an accept naming nothing known leaves the dialog unfiltered', () => {
  expect(filtersFor('application/x-nonesuch')).toBeUndefined();
});

test('Android opens the platform picker and preserves the provider metadata', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  const uri = { uri: 'content://media/1', documentTopTreeUri: null };
  mocks.androidFs.showOpenFilePicker.mockResolvedValue([uri]);
  mocks.androidFs.getMetadata.mockResolvedValue({
    type: 'File',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    lastModified: new Date(1_700_000_000_000),
  });
  mocks.androidFs.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

  const files = await pickFiles('image/*,video/*');

  expect(mocks.androidFs.showOpenFilePicker).toHaveBeenCalledWith({
    pickerType: 'Gallery',
    mimeTypes: ['image/*', 'video/*'],
    multiple: true,
  });
  expect(files?.map(({ name, type, lastModified }) => ({ name, type, lastModified }))).toEqual([
    { name: 'photo.jpg', type: 'image/jpeg', lastModified: 1_700_000_000_000 },
  ]);
});

test('Android uses the document picker for arbitrary attachments', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  mocks.androidFs.showOpenFilePicker.mockResolvedValue([]);

  await pickFiles('*');

  expect(mocks.androidFs.showOpenFilePicker).toHaveBeenCalledWith({
    pickerType: 'FilePicker',
    mimeTypes: [],
    multiple: true,
  });
});

test('iOS reads and removes the picker copy', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('ios');
  mocks.dialogOpen.mockResolvedValue('/tmp/photo.jpg');
  mocks.fsReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.fsRemove.mockResolvedValue(undefined);

  const files = await pickFiles('image/*,video/*');

  expect(mocks.dialogOpen).toHaveBeenCalledWith(
    expect.objectContaining({ multiple: true, pickerMode: 'media' })
  );
  expect(files?.map(({ name, type }) => ({ name, type }))).toEqual([
    { name: 'photo.jpg', type: 'image/jpeg' },
  ]);
  expect(mocks.fsRemove).toHaveBeenCalledWith('/tmp/photo.jpg');
});

test('iOS keeps a readable attachment when picker cleanup fails', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('ios');
  mocks.dialogOpen.mockResolvedValue('/tmp/photo.jpg');
  mocks.fsReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.fsRemove.mockRejectedValue(new Error('cleanup failed'));

  const files = await pickFiles('image/*');

  expect(files).toHaveLength(1);
  expect(files?.[0]?.name).toBe('photo.jpg');
});

test('Android saves downloads to the public Downloads collection', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

  await expect(saveFile('https://example.org/report.pdf', 'report.pdf')).resolves.toBe('saved');

  expect(mocks.androidFs.createNewPublicFile).toHaveBeenCalledWith(
    'Download',
    'report.pdf',
    'application/pdf',
    { isPending: true, requestPermission: true }
  );
  expect(mocks.androidFs.setPublicFilePending).toHaveBeenCalledWith(
    { uri: 'content://downloads/file' },
    false
  );
  expect(mocks.androidFs.scanPublicFile).toHaveBeenCalledWith({ uri: 'content://downloads/file' });
});

test('Android saves images to the public Pictures collection', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

  await expect(saveImageToPhotos('https://example.org/photo.jpg', 'photo.jpg')).resolves.toBe(
    'saved'
  );

  expect(mocks.androidFs.createNewPublicImageFile).toHaveBeenCalledWith(
    'Pictures',
    'photo.jpg',
    'image/jpeg',
    { isPending: true, requestPermission: true }
  );
});

test('iOS sends image bytes to the native Photos command', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('ios');
  mocks.invoke.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

  await expect(saveImageToPhotos('https://example.org/photo.png', 'photo.png')).resolves.toBe(
    'saved'
  );

  expect(mocks.invoke).toHaveBeenCalledWith('save_media_to_photos', new Uint8Array([1, 2, 3]), {
    headers: { filename: 'photo.png', 'mime-type': 'image%2Fpng' },
  });
});

test('iOS carries a non-ASCII filename a header value cannot hold', async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('ios');
  mocks.invoke.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));

  await expect(saveImageToPhotos('https://example.org/p.png', 'été 😂.png')).resolves.toBe('saved');

  const options = (mocks.invoke.mock.calls.at(-1) ?? [])[2] as {
    headers: Record<string, string>;
  };
  const { headers } = options;
  expect(headers.filename).toBe(encodeURIComponent('été 😂.png'));
  for (const value of Object.values(headers)) expect(value).toMatch(/^[ -~]*$/);
});

test('the share sheet is native everywhere it exists, and nowhere on the web', async () => {
  mocks.isTauri.mockReturnValue(false);
  expect(await sharesNatively()).toBe(false);

  mocks.isTauri.mockReturnValue(true);
  for (const os of ['android', 'ios', 'macos', 'windows']) {
    mocks.osType.mockReturnValue(os);
    expect(await sharesNatively()).toBe(true);
  }

  mocks.osType.mockReturnValue('linux');
  expect(await sharesNatively()).toBe(false);
});

test('sharing writes the media to the cache and hands over a file URL', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));

  expect(await shareFile('blob:media', 'holiday.png')).toBe('saved');
  expect(mocks.fsWriteFile).toHaveBeenCalledWith('/cache/holiday.png', new Uint8Array([1, 2, 3]));
  expect(mocks.shareNative).toHaveBeenCalledWith('file:///cache/holiday.png', {
    mimeType: 'image/png',
    title: 'holiday.png',
  });
});

test('a body carrying a path cannot write outside the cache directory', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));

  await shareFile('blob:media', '../../etc/passwd', 'image/png');
  expect(mocks.fsWriteFile).toHaveBeenCalledWith('/cache/passwd', expect.anything());
});

test('a refused share reports the failure rather than throwing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
  mocks.shareNative.mockRejectedValue(new Error('cancelled'));

  expect(await shareFile('blob:media', 'holiday.png')).toBe('failed');
});
