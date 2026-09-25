// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const files = vi.hoisted(() => ({
  pickFiles: vi.fn<(accept: string) => Promise<File[] | null>>(),
  saveBytes:
    vi.fn<
      (
        bytes: Uint8Array,
        filename: string,
        mime: string
      ) => Promise<'saved' | 'cancelled' | 'failed'>
    >(),
}));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));
vi.mock('#lib/core/context.js');
vi.mock('#lib/platform/files.js', () => files);

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  exportRoomKeys: vi.fn<(passphrase: string) => Promise<string>>(),
  importRoomKeys:
    vi.fn<(exported: string, passphrase: string) => Promise<{ imported: number; total: number }>>(),
});

import RoomKeyFile from './RoomKeyFile.svelte';

const EXPORT = '-----BEGIN MEGOLM SESSION DATA-----\nAAAA\n-----END MEGOLM SESSION DATA-----';

beforeEach(() => {
  core.exportRoomKeys.mockReset();
  core.importRoomKeys.mockReset();
  files.pickFiles.mockReset();
  files.saveBytes.mockReset();
});

afterEach(() => {
  history.state.overlay = undefined;
  document.body.replaceChildren();
});

function fill(selector: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function rowButton(id: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`#${id} .btn`);
  if (!button) throw new Error(`Missing ${id} button`);
  return button;
}

async function pickKeyFile(): Promise<void> {
  files.pickFiles.mockResolvedValue([new File([EXPORT], 'element-keys.txt')]);
  rowButton('room-keys-import').click();
  await vi.waitFor(() => {
    expect(document.querySelector('#room-keys-import-passphrase')).not.toBeNull();
  });
  fill('#room-keys-import-passphrase', 'secret');
  await tick();
}

test('exports only once the passphrase is confirmed, then saves the armored file', async () => {
  core.exportRoomKeys.mockResolvedValue(EXPORT);
  files.saveBytes.mockResolvedValue('saved');
  const instance = mount(RoomKeyFile, { target: document.body });

  rowButton('room-keys-export').click();
  await tick();
  fill('#room-keys-export-passphrase', 'secret');
  fill('#room-keys-export-confirm', 'secre');
  await tick();

  const submit = document.querySelector<HTMLButtonElement>('.room-keys-form button[type="submit"]');
  expect(submit?.disabled).toBe(true);
  expect(document.querySelector('.room-keys-form [role="alert"]')?.textContent).toContain(
    'do not match'
  );

  fill('#room-keys-export-confirm', 'secret');
  await tick();
  document.querySelector<HTMLFormElement>('.room-keys-form')?.requestSubmit();

  await vi.waitFor(() => {
    expect(document.querySelector('.alert-success')?.textContent).toContain('sable-keys.txt');
  });
  expect(core.exportRoomKeys).toHaveBeenCalledWith('secret');
  const [bytes, filename, mime] = files.saveBytes.mock.calls[0];
  expect(new TextDecoder().decode(bytes)).toBe(EXPORT);
  expect([filename, mime]).toEqual(['sable-keys.txt', 'text/plain']);
  expect(document.querySelector('.room-keys-form')).toBeNull();

  await unmount(instance);
});

test('imports the picked file and reports how many keys were new', async () => {
  core.importRoomKeys.mockResolvedValue({ imported: 3, total: 5 });
  const instance = mount(RoomKeyFile, { target: document.body });

  await pickKeyFile();
  expect(document.querySelector('.room-keys-file')?.textContent).toBe('element-keys.txt');
  document.querySelector<HTMLFormElement>('.room-keys-form')?.requestSubmit();

  await vi.waitFor(() => {
    expect(document.querySelector('.alert-success')?.textContent.trim()).toBe(
      'Imported 3 of 5 keys.'
    );
  });
  expect(core.importRoomKeys).toHaveBeenCalledWith(EXPORT, 'secret');
  expect(document.querySelector('.room-keys-form')).toBeNull();

  await unmount(instance);
});

test.each([
  ['denied', 'That passphrase does not open this file.'],
  ['invalid_key_export', 'That file is not a key export.'],
  ['unavailable', 'The keys could not be imported.'],
] as const)('explains a %s import and keeps the file to retry', async (code, message) => {
  core.importRoomKeys.mockRejectedValue(new CoreError({ code }));
  const instance = mount(RoomKeyFile, { target: document.body });

  await pickKeyFile();
  document.querySelector<HTMLFormElement>('.room-keys-form')?.requestSubmit();

  await vi.waitFor(() => {
    expect(document.querySelector('.alert-critical')?.textContent.trim()).toBe(message);
  });
  expect(document.querySelector('.room-keys-file')?.textContent).toBe('element-keys.txt');

  await unmount(instance);
});
