// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core } from '#lib/core/__mocks__/context.js';

import MeowlnirBanDialog from './MeowlnirBanDialog.svelte';

const management = {
  roomId: '!management:example.org',
  userId: '@me:example.org',
  protectedRooms: ['!lobby:example.org'],
  lists: [{ shortcode: 'spam', name: 'Spam list' }],
};
const props = { open: true, management, userId: '@bad:example.org', name: 'Bad' };

const send = vi.fn<(params: object) => Promise<null>>(() => Promise.resolve(null));
Object.assign(core.rpc.messages, { send });
Object.assign(core.rpc.room_state, { botCommands: vi.fn(() => Promise.resolve([])) });

beforeEach(() => {
  vi.clearAllMocks();
});

test('banning sends the command to the management room, not the room the user is in', async () => {
  const user = userEvent.setup();
  render(MeowlnirBanDialog, props);

  await user.type(screen.getByLabelText('room.moderationRuleReason'), 'spam links');
  await user.click(screen.getByRole('button', { name: 'timeline.meowlnirBan' }));

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        room_id: '!management:example.org',
        body: '!ban spam @bad:example.org spam links',
      })
    );
  });
});

test('removing their messages too sends a takedown', async () => {
  const user = userEvent.setup();
  render(MeowlnirBanDialog, props);

  await user.click(screen.getByRole('switch', { name: 'timeline.meowlnirBanTakedown' }));
  await user.click(screen.getByRole('button', { name: 'timeline.meowlnirBan' }));

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ body: '!takedown spam @bad:example.org' })
    );
  });
});

test('a failed send keeps the dialog open and says so', async () => {
  send.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  render(MeowlnirBanDialog, props);

  await user.click(screen.getByRole('button', { name: 'timeline.meowlnirBan' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('timeline.profileModerationFailed');
});
