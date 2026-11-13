// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
const roomList = vi.hoisted(() => ({ joined: true }));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    byId: (id: string) => (roomList.joined ? { room_id: id, state: 'joined' } : undefined),
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import ModerationListRules from './ModerationListRules.svelte';

const props = {
  managementRoomId: '!management:example.org',
  listRoomId: '!list:example.org',
  name: 'Spam list',
  shortcode: 'spam',
  canEdit: true,
};

const fullState = vi.fn();
const botCommands = vi.fn(() => Promise.resolve([]));
const send = vi.fn(() => Promise.resolve(null));
const join = vi.fn(() => Promise.resolve('!list:example.org'));
Object.assign(core.rpc.room_state, { fullState, botCommands });
Object.assign(core.rpc.messages, { send });
Object.assign(core.rpc.rooms, { join });

beforeEach(() => {
  vi.clearAllMocks();
  roomList.joined = true;
  fullState.mockResolvedValue([
    {
      type: 'm.policy.rule.user',
      state_key: 'a',
      content: { entity: '@bad:example.org', recommendation: 'm.ban', reason: 'spam' },
    },
  ]);
});

test('a new rule goes to Meowlnir in the management room', async () => {
  const user = userEvent.setup();
  render(ModerationListRules, props);

  expect(await screen.findByText('@bad:example.org')).toBeInTheDocument();
  const add = screen.getByRole('button', { name: 'room.moderationRuleAdd' });
  expect(add).toBeDisabled();

  await user.type(screen.getByLabelText('room.moderationRuleEntity'), '@worse:example.org');
  await user.type(screen.getByLabelText('room.moderationRuleReason'), 'raid');
  await user.click(add);

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        room_id: '!management:example.org',
        body: '!ban spam @worse:example.org raid',
      })
    );
  });
});

test('removing a rule asks first, then tells Meowlnir', async () => {
  const user = userEvent.setup();
  render(ModerationListRules, props);

  await user.click(
    await screen.findByRole('button', { name: 'room.moderationRuleRemove:@bad:example.org' })
  );
  expect(send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'common.remove' }));

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ body: '!remove-policy spam @bad:example.org' })
    );
  });
});

test('a list without a short name, or a member without the role, cannot change rules', async () => {
  const { unmount } = render(ModerationListRules, { ...props, shortcode: null });
  expect(await screen.findByText('room.moderationRulesNoShortcode')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'room.moderationRuleAdd' })).toBeNull();
  unmount();

  render(ModerationListRules, { ...props, canEdit: false });
  expect(await screen.findByText('@bad:example.org')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'room.moderationRuleAdd' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'room.moderationRuleRemove:@bad:example.org' })
  ).toBeNull();
});

test('a list the user is not in offers to join instead of reading it', async () => {
  roomList.joined = false;
  const user = userEvent.setup();
  render(ModerationListRules, props);

  await user.click(screen.getByRole('button', { name: 'common.join' }));

  expect(join).toHaveBeenCalledWith({ address: '!list:example.org', via: [] });
  expect(fullState).not.toHaveBeenCalled();
});
