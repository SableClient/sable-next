// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { MemberLookView, RoomSummary } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], labelFor: (id: string) => id, byId: () => undefined }),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import RoomCosmeticsSettings from './RoomCosmeticsSettings.svelte';

const core = Object.assign(baseCore, {
  memberLook: vi.fn<(...args: never[]) => Promise<MemberLookView>>(() => Promise.resolve(look())),
  setMemberLook: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
  setPronouns: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
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
  is_space: false,
  space_children: [],
} as unknown as RoomSummary;

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
  core.memberLook.mockResolvedValue(
    look({ display_name: 'Stale', avatar_url: 'mxc://example.org/stale' })
  );
  const user = userEvent.setup();
  render(RoomCosmeticsSettings, { room, permissions: null, levels: null });

  const reset = await screen.findByRole('button', { name: 'common.reset' });
  expect(reset).toBeEnabled();
  await user.click(reset);

  await vi.waitFor(() => {
    expect(core.setMemberLook).toHaveBeenCalledWith('!room:example.org', {
      display_name: { kind: 'set', value: 'Live' },
      avatar_url: { kind: 'set', value: 'mxc://example.org/live' },
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
  core.memberLook.mockResolvedValue(
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
    expect(core.setMemberLook).toHaveBeenCalledTimes(1);
  });
  expect(core.setMemberLook).toHaveBeenCalledWith('!room:example.org', {
    display_name: { kind: 'set', value: 'Live' },
    avatar_url: { kind: 'set', value: 'mxc://example.org/live' },
    color_on_light: { kind: 'clear' },
    color_on_dark: { kind: 'clear' },
  });
});
