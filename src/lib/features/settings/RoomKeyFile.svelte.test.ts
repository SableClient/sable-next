// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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
});

function form(): HTMLElement {
  const found = screen.getByLabelText('Passphrase').closest('form');
  if (!found) throw new Error('Missing room key form');
  return found;
}

async function pickKeyFile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  files.pickFiles.mockResolvedValue([new File([EXPORT], 'element-keys.txt')]);
  await user.click(screen.getByRole('button', { name: 'Import' }));
  await user.type(await screen.findByLabelText('Passphrase'), 'secret');
}

test('exports only once the passphrase is confirmed, then saves the armored file', async () => {
  const user = userEvent.setup();
  core.exportRoomKeys.mockResolvedValue(EXPORT);
  files.saveBytes.mockResolvedValue('saved');
  render(RoomKeyFile);

  await user.click(screen.getByRole('button', { name: 'Export' }));
  await user.type(screen.getByLabelText('Passphrase'), 'secret');
  await user.type(screen.getByLabelText('Confirm passphrase'), 'secre');

  const submit = within(form()).getByRole('button', { name: 'Export' });
  expect(submit).toBeDisabled();
  expect(within(form()).getByRole('alert')).toHaveTextContent('do not match');

  await user.type(screen.getByLabelText('Confirm passphrase'), 't');
  await user.click(submit);

  expect(await screen.findByRole('status')).toHaveTextContent('sable-keys.txt');
  expect(core.exportRoomKeys).toHaveBeenCalledWith('secret');
  const [bytes, filename, mime] = files.saveBytes.mock.calls[0];
  expect(new TextDecoder().decode(bytes)).toBe(EXPORT);
  expect([filename, mime]).toEqual(['sable-keys.txt', 'text/plain']);
  expect(screen.queryByLabelText('Passphrase')).not.toBeInTheDocument();
});

test('imports the picked file and reports how many keys were new', async () => {
  const user = userEvent.setup();
  core.importRoomKeys.mockResolvedValue({ imported: 3, total: 5 });
  render(RoomKeyFile);

  await pickKeyFile(user);
  expect(within(form()).getByText('element-keys.txt')).toBeInTheDocument();
  await user.click(within(form()).getByRole('button', { name: 'Import' }));

  expect(await screen.findByRole('status')).toHaveTextContent('Imported 3 of 5 keys.');
  expect(core.importRoomKeys).toHaveBeenCalledWith(EXPORT, 'secret');
  expect(screen.queryByLabelText('Passphrase')).not.toBeInTheDocument();
});

test.each([
  ['denied', 'That passphrase does not open this file.'],
  ['invalid_key_export', 'That file is not a key export.'],
  ['unavailable', 'The keys could not be imported.'],
] as const)('explains a %s import and keeps the file to retry', async (code, message) => {
  const user = userEvent.setup();
  core.importRoomKeys.mockRejectedValue(new CoreError({ code }));
  render(RoomKeyFile);

  await pickKeyFile(user);
  await user.click(within(form()).getByRole('button', { name: 'Import' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(within(form()).getByText('element-keys.txt')).toBeInTheDocument();
});
