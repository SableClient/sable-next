// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/ui/media-url.js', () => ({
  holdMediaUrl: () => () => {},
  loadMediaUrl: vi.fn(() => Promise.resolve('blob:background')),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import ChatBackground from './ChatBackground.svelte';

const layer = () => document.querySelector<HTMLElement>('.chat-background');

afterEach(() => {
  setPreference('chatBackgroundImage', '');
  setPreference('chatBackgroundColor', '');
});

test('draws nothing until a background is chosen', () => {
  render(ChatBackground);
  expect(layer()).toBeNull();
});

test('paints the chosen colour and ignores one that is not a colour', () => {
  setPreference('chatBackgroundColor', '#112233');
  const { unmount } = render(ChatBackground);
  expect(layer()?.style.backgroundColor).toBe('#112233');
  unmount();

  setPreference('chatBackgroundColor', 'url(https://example.org/x)');
  render(ChatBackground);
  expect(layer()).toBeNull();
});

test('shows the chosen picture once it has loaded', async () => {
  setPreference('chatBackgroundImage', 'mxc://example.org/wall');
  render(ChatBackground);
  await vi.waitFor(() => {
    expect(layer()?.style.backgroundImage).toBe('url("blob:background")');
  });
  expect(layer()).toHaveClass('pictured');
});

test('a room with a background of its own shows it in place of the general one', async () => {
  setPreference('chatBackgroundColor', '#112233');
  core.rpc.room_state.accountData.mockResolvedValue({ color: '#445566', image: 'not a picture' });
  render(ChatBackground, { roomId: '!room:example.org' });
  await vi.waitFor(() => {
    expect(layer()?.style.backgroundColor).toBe('#445566');
  });
  expect(layer()).not.toHaveClass('pictured');
});

test('a room without one keeps the general background', async () => {
  setPreference('chatBackgroundColor', '#112233');
  core.rpc.room_state.accountData.mockResolvedValue(null);
  render(ChatBackground, { roomId: '!other:example.org' });
  await vi.waitFor(() => {
    expect(core.rpc.room_state.accountData).toHaveBeenCalledWith({
      room_id: '!other:example.org',
      event_type: 'moe.sable.chat_background',
    });
  });
  await vi.waitFor(() => {
    expect(layer()?.style.backgroundColor).toBe('#112233');
  });
});

test('the general background waits until the room is known to have none of its own', async () => {
  setPreference('chatBackgroundColor', '#112233');
  const answer = Promise.withResolvers<null>();
  core.rpc.room_state.accountData.mockReturnValue(answer.promise);
  render(ChatBackground, { roomId: '!slow:example.org' });
  await vi.waitFor(() => {
    expect(core.rpc.room_state.accountData).toHaveBeenCalled();
  });
  expect(layer()).toBeNull();

  answer.resolve(null);
  await vi.waitFor(() => {
    expect(layer()?.style.backgroundColor).toBe('#112233');
  });
});
