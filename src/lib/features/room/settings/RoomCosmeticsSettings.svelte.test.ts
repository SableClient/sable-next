// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MemberLookView, RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], labelFor: (id: string) => id, byId: () => undefined }),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import { MAX_DISPLAY_NAME_LENGTH } from '#lib/profile/fields.js';
import { MAX_PRONOUN_INPUT } from '#lib/profile/pronouns.js';

import RoomCosmeticsSettings from './RoomCosmeticsSettings.svelte';

const core = baseCore;
Object.assign(core.rpc.members, {
  look: vi.fn<(...args: never[]) => Promise<MemberLookView>>(() => Promise.resolve(look())),
  setLook: vi.fn<(...args: never[]) => Promise<null>>(() => Promise.resolve(null)),
  setPronouns: vi.fn<(...args: never[]) => Promise<null>>(() => Promise.resolve(null)),
});

function look(overrides: Partial<MemberLookView> = {}): MemberLookView {
  return {
    display_name: null,
    avatar_url: null,
    color_on_light: null,
    color_on_dark: null,
    pronouns: [],
    ...overrides,
  };
}

const room = {
  room_id: '!room:example.org',
  space_children: [],
} as unknown as RoomListItemView;

beforeEach(() => {
  core.session = { user_id: '@me:example.org' };
});

afterEach(() => {
  vi.clearAllMocks();
  core.session = null;
});

test('reset writes the live profile when the room profile only matches a stale one', async () => {
  core.userProfile.mockResolvedValue({
    display_name: 'Stale',
    avatar_url: 'mxc://example.org/stale',
  });
  core.refreshUserProfile.mockResolvedValue({
    display_name: 'Live',
    avatar_url: 'mxc://example.org/live',
  });
  core.rpc.members.look.mockResolvedValue(
    look({ display_name: 'Stale', avatar_url: 'mxc://example.org/stale' })
  );
  const user = userEvent.setup();
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  const reset = await screen.findByRole('button', { name: 'common.reset' });
  expect(reset).toBeEnabled();
  await user.click(reset);

  await vi.waitFor(() => {
    expect(core.rpc.members.setLook).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      in_parent_space: false,
      display_name: { kind: 'set', value: 'Live' },
      avatar_url: { kind: 'set', value: 'mxc://example.org/live' },
      color_on_light: { kind: 'keep' },
      color_on_dark: { kind: 'keep' },
    });
  });
});

test('reset is enabled when the profile cannot be fetched', async () => {
  core.refreshUserProfile.mockRejectedValue(new Error('offline'));
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  expect(await screen.findByRole('button', { name: 'common.reset' })).toBeEnabled();
});

test('reset writes the member event once and drops the colours with it', async () => {
  core.refreshUserProfile.mockResolvedValue({
    display_name: 'Live',
    avatar_url: 'mxc://example.org/live',
  });
  core.rpc.members.look.mockResolvedValue(
    look({
      display_name: 'Custom',
      avatar_url: 'mxc://example.org/custom',
      color_on_light: '#112233',
    })
  );
  const user = userEvent.setup();
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  await user.click(await screen.findByRole('button', { name: 'common.reset' }));

  await vi.waitFor(() => {
    expect(core.rpc.members.setLook).toHaveBeenCalledTimes(1);
  });
  expect(core.rpc.members.setLook).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    in_parent_space: false,
    display_name: { kind: 'set', value: 'Live' },
    avatar_url: { kind: 'set', value: 'mxc://example.org/live' },
    color_on_light: { kind: 'clear' },
    color_on_dark: { kind: 'clear' },
  });
});

test('the room nickname and pronouns share the profile editor limits', async () => {
  core.userProfile.mockResolvedValue({ display_name: 'Me', avatar_url: null });
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  expect(await screen.findByRole('textbox', { name: 'room.cosmeticsName' })).toHaveAttribute(
    'maxlength',
    String(MAX_DISPLAY_NAME_LENGTH)
  );
  expect(screen.getByRole('textbox', { name: 'room.cosmeticsPronouns' })).toHaveAttribute(
    'maxlength',
    String(MAX_PRONOUN_INPUT)
  );
});

test('a picture chosen for the room is saved as its chat background', async () => {
  const uploadMedia = vi.fn(() => Promise.resolve('mxc://example.org/wall'));
  Object.assign(baseCore, { uploadMedia });
  core.rpc.room_state.accountData.mockResolvedValue(null);
  core.rpc.room_state.setAccountData.mockResolvedValue(null);
  const user = userEvent.setup();
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  await user.upload(
    await screen.findByLabelText('settings.chatBackgroundChoose'),
    new File(['picture'], 'wall.png', { type: 'image/png' })
  );

  await vi.waitFor(() => {
    expect(core.rpc.room_state.setAccountData).toHaveBeenCalledWith({
      room_id: room.room_id,
      event_type: 'moe.sable.chat_background',
      content: { image: 'mxc://example.org/wall', color: '' },
    });
  });
  expect(
    await screen.findByRole('button', { name: 'settings.chatBackgroundRemove' })
  ).toBeVisible();
});
