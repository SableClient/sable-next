// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView, RoomPowerLevelsView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { defaultE2eePolicy } from '#lib/deployment/e2ee-policy.js';

import RoomEncryptionSettings from './RoomEncryptionSettings.svelte';

Object.assign(core, { e2eePolicy: () => Promise.resolve(defaultE2eePolicy) });

const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {},
  users: {},
  notifications_room: 50,
};

function room(encrypted: boolean | null): RoomListItemView {
  return { room_id: '!room:example.org', encrypted } as RoomListItemView;
}

test('a member who cannot enable encryption sees that the room is not encrypted', () => {
  render(RoomEncryptionSettings, { room: room(false), levels, ownPowerLevel: 0 });

  expect(screen.getByText('room.encryptionNotEnabled')).toBeTruthy();
  expect(screen.getByText('room.encryptionNotOn')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'room.permEncryption' })).toBeNull();
});

test('a moderator still gets the button to enable encryption', () => {
  render(RoomEncryptionSettings, { room: room(false), levels, ownPowerLevel: 50 });

  expect(screen.getByRole('button', { name: 'room.permEncryption' })).toBeTruthy();
  expect(screen.queryByText('room.encryptionNotEnabled')).toBeNull();
});

test('an unknown encryption state claims nothing', () => {
  render(RoomEncryptionSettings, { room: room(null), levels, ownPowerLevel: 0 });

  expect(screen.queryByText('room.encryptionNotEnabled')).toBeNull();
});
