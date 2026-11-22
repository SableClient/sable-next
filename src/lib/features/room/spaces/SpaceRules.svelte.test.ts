// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';

import type { RoomRulesView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [],
    labelFor: (roomId: string) => roomId,
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { roomView } from '#lib/test-support/room-views.js';

import SpaceRules from './SpaceRules.svelte';

const space = roomView({
  room_id: '!space:example.org',
  name: 'Design',
  display_name: 'Design',
  room_kind: 'space',
});

const user = userEvent.setup();

function view(overrides: Partial<RoomRulesView> = {}): RoomRulesView {
  return {
    source_room_id: '!space:example.org',
    html: '<p>Be kind</p>',
    version: 2,
    require_acceptance: false,
    accepted: false,
    updated_at: 1,
    ...overrides,
  };
}

beforeEach(() => {
  core.rpc.room_state.rules.mockReset();
});

test('shows the rules a space has set and when they last changed', async () => {
  core.rpc.room_state.rules.mockResolvedValue(view());

  render(SpaceRules, { space });

  expect(await screen.findByText('Be kind')).toBeVisible();
  expect(await screen.findByText(/^room\.rulesUpdated:/)).toBeVisible();
  expect(core.rpc.room_state.rules).toHaveBeenCalledWith({ room_id: '!space:example.org' });
});

test('offers a retry when the rules cannot be loaded', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  onTestFinished(() => {
    debug.mockRestore();
  });
  core.rpc.room_state.rules
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(view());

  render(SpaceRules, { space });
  expect(await screen.findByRole('alert')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'common.retry' }));

  expect(await screen.findByText('Be kind')).toBeVisible();
});
