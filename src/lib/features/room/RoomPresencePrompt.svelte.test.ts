// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { PresencePromptView, PresenceSharingView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';

import RoomPresencePrompt from './RoomPresencePrompt.svelte';

const presencePrompt = vi.fn<() => Promise<PresencePromptView | null>>();
const answerPresencePrompt = vi.fn(() => Promise.resolve(null));
Object.assign(core.rpc.rooms, { presencePrompt, answerPresencePrompt });

const supported = { hint_event_type: 'm.room.presence_sharing' } as PresenceSharingView;

afterEach(() => {
  vi.clearAllMocks();
  presenceSharing.view = null;
});

test('asks nothing while the server lacks selective presence', async () => {
  presencePrompt.mockResolvedValue({ kind: 'room', room_id: '!r:example.org' });
  render(RoomPresencePrompt, { roomId: '!r:example.org', roomName: 'Room' });
  await Promise.resolve();

  expect(presencePrompt).not.toHaveBeenCalled();
  expect(screen.queryByRole('region')).toBeNull();
});

test('shares with the other person of a DM', async () => {
  const user = userEvent.setup();
  presenceSharing.view = supported;
  const prompt: PresencePromptView = { kind: 'user', user_id: '@bob:example.org' };
  presencePrompt.mockResolvedValue(prompt);
  render(RoomPresencePrompt, { roomId: '!dm:example.org', roomName: 'Bob' });

  expect(await screen.findByText('room.presencePromptUser:Bob')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'room.presencePromptShare' }));

  expect(answerPresencePrompt).toHaveBeenCalledWith({ prompt, share: true });
  expect(screen.queryByRole('region')).toBeNull();
});

test('declining records the prompt without sharing', async () => {
  const user = userEvent.setup();
  presenceSharing.view = supported;
  const prompt: PresencePromptView = { kind: 'room', room_id: '!r:example.org' };
  presencePrompt.mockResolvedValue(prompt);
  render(RoomPresencePrompt, { roomId: '!r:example.org', roomName: 'Room' });

  await user.click(await screen.findByRole('button', { name: 'room.presencePromptDecline' }));

  expect(answerPresencePrompt).toHaveBeenCalledWith({ prompt, share: false });
});
