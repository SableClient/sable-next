// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

const rooms = vi.hoisted(() => [] as RoomSummary[]);
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms }),
  roomLabel: (room: RoomSummary) => room.name ?? room.room_id,
}));

import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';

import InviteList from './InviteList.svelte';

Object.assign(core, {
  accountData: vi.fn(() => Promise.resolve(null)),
  setAccountData: vi.fn(() => Promise.resolve()),
});

function invite(roomId: string, name: string): RoomSummary {
  return { room_id: roomId, name, state: 'invited', latest_event: null } as unknown as RoomSummary;
}

afterEach(() => {
  document.body.replaceChildren();
  dismissedInvites.stop();
  rooms.length = 0;
});

function names(): string[] {
  return [...document.querySelectorAll('.name-text')].map((node) => node.textContent);
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent.trim().startsWith(label)
  );
}

test('a dismissed invite moves behind the dismissed toggle and can be restored', async () => {
  rooms.push(invite('!a:example.org', 'Alpha'), invite('!b:example.org', 'Beta'));
  dismissedInvites.start(core as unknown as CoreClient);
  const instance = mount(InviteList, { target: document.body });
  await tick();
  expect(names()).toEqual(['Alpha', 'Beta']);

  button('Dismiss')?.click();
  await vi.waitFor(() => {
    expect(names()).toEqual(['Beta']);
  });

  button('1 dismissed')?.click();
  flushSync();
  expect(names()).toEqual(['Alpha']);

  button('Restore')?.click();
  await vi.waitFor(() => {
    expect(names()).toEqual(['Alpha', 'Beta']);
  });
  await unmount(instance);
});
