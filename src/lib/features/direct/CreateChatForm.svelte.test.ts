// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.rooms, {
  createDm: vi.fn<() => Promise<string>>(),
  join: vi.fn<(params: { address: string; via: string[] }) => Promise<string>>(),
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '#lib/test-support/app-navigation.js';
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string>) =>
    path.replace('[roomId]', params.roomId),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => encodeURIComponent(roomId),
}));

import CreateChatForm from './CreateChatForm.svelte';

const input = () => screen.getByRole('textbox', { name: 'direct.addressLabel' });

async function submit(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(input(), value);
  await user.click(screen.getByRole('button', { name: 'direct.submit' }));
}

beforeEach(() => {
  core.rpc.rooms.createDm.mockReset();
  core.rpc.rooms.join.mockReset();
  core.e2eePolicy.mockResolvedValue({ defaultEncrypted: true, forceDisabled: false });
  vi.mocked(goto).mockClear();
});

test('creates the chat and navigates to it under the direct section', async () => {
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');
  render(CreateChatForm);

  await submit('@alice:example.org');
  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      encrypted: true,
      encrypt_new: true,
    });
  });

  expect(goto).toHaveBeenCalledWith('/(app)/direct/!dm%3Aexample.org');
});

test('creates an unencrypted chat when the switch is turned off', async () => {
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');
  render(CreateChatForm);

  await userEvent.setup().click(screen.getByRole('switch', { name: 'common.endToEndEncryption' }));
  await submit('@alice:example.org');
  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      encrypted: false,
      encrypt_new: true,
    });
  });
});

test('rejects an input that is not a user id without calling the core', async () => {
  render(CreateChatForm);

  await submit('alice');

  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
  expect(input()).toBeInvalid();
  expect(input()).toHaveAccessibleDescription('direct.addressInvalid');
});

test('reports a failed creation and stays on the page', async () => {
  core.rpc.rooms.createDm.mockRejectedValue(new Error('nope'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(CreateChatForm);

  await submit('@alice:example.org');
  expect(await screen.findByRole('alert')).toHaveTextContent('direct.failed');

  expect(goto).not.toHaveBeenCalled();
  warn.mockRestore();
});

test.each([
  ['#lobby:example.org', '#lobby:example.org', []],
  [
    '!dIz4NfOB_FDBH4ktZeSqqTfPEcBwm4KnNTnJptVRDko',
    '!dIz4NfOB_FDBH4ktZeSqqTfPEcBwm4KnNTnJptVRDko',
    [],
  ],
  [
    'https://matrix.to/#/!dIz4NfOB_FDBH4ktZeSqqTfPEcBwm4KnNTnJptVRDko?via=one.org',
    '!dIz4NfOB_FDBH4ktZeSqqTfPEcBwm4KnNTnJptVRDko',
    ['one.org'],
  ],
])('joins the room %s instead of starting a chat', async (value, address, via) => {
  core.rpc.rooms.join.mockResolvedValue('!joined:example.org');
  render(CreateChatForm);

  await userEvent.setup().type(input(), value);
  expect(screen.queryByRole('switch')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'common.join' }));

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/(app)/rooms/!joined%3Aexample.org');
  });
  expect(core.rpc.rooms.join).toHaveBeenCalledWith({ address, via });
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
});

test('a server forcing encryption off hides the switch and creates an unencrypted chat', async () => {
  core.e2eePolicy.mockResolvedValue({ defaultEncrypted: true, forceDisabled: true });
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');
  render(CreateChatForm);

  await vi.waitFor(() => {
    expect(screen.queryByRole('switch', { name: 'common.endToEndEncryption' })).toBeNull();
  });
  await submit('@alice:example.org');
  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      encrypted: false,
      encrypt_new: false,
    });
  });
});

test('a server defaulting encryption off starts the switch off', async () => {
  core.e2eePolicy.mockResolvedValue({ defaultEncrypted: false, forceDisabled: false });
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');
  render(CreateChatForm);

  await vi.waitFor(() => {
    expect(screen.getByRole('switch', { name: 'common.endToEndEncryption' })).not.toBeChecked();
  });
  await submit('@alice:example.org');
  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      encrypted: false,
      encrypt_new: false,
    });
  });
});
