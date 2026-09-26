// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, { createDm: vi.fn<() => Promise<string>>() });
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

const input = () => screen.getByRole('textbox', { name: 'direct.userIdLabel' });

async function submit(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(input(), value);
  await user.click(screen.getByRole('button', { name: 'direct.submit' }));
}

beforeEach(() => {
  core.createDm.mockReset();
});

test('creates the chat and navigates to it under the direct section', async () => {
  core.createDm.mockResolvedValue('!dm:example.org');
  render(CreateChatForm);

  await submit('@alice:example.org');
  await vi.waitFor(() => {
    expect(core.createDm).toHaveBeenCalledWith('@alice:example.org');
  });

  expect(goto).toHaveBeenCalledWith('/(app)/direct/!dm%3Aexample.org');
});

test('rejects an input that is not a user id without calling the core', async () => {
  render(CreateChatForm);

  await submit('alice');

  expect(core.createDm).not.toHaveBeenCalled();
  expect(input()).toBeInvalid();
  expect(input()).toHaveAccessibleDescription('direct.invalid');
});

test('reports a failed creation and stays on the page', async () => {
  core.createDm.mockRejectedValue(new Error('nope'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(CreateChatForm);

  await submit('@alice:example.org');
  expect(await screen.findByRole('alert')).toHaveTextContent('direct.failed');

  expect(goto).not.toHaveBeenCalled();
  warn.mockRestore();
});
