// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RoomPreviewView, UserDirectoryEntryView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) =>
    (path.startsWith('/') ? path : `/${path}`)
      .replace('/(app)', '')
      .replace(/\[([^\]]+)\]/g, (_, key: string) => params[key] ?? key),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/core/context.js');

import { goto } from '$app/navigation';
import { core } from '#lib/core/__mocks__/context.js';

import FindOrJoinDialog from './FindOrJoinDialog.svelte';
import { findOrJoinState, openFindOrJoin } from '#lib/ui/find-or-join-state.svelte.js';

function preview(overrides: Partial<RoomPreviewView> = {}): RoomPreviewView {
  return {
    room_id: '!room:example.org',
    canonical_alias: '#lounge:example.org',
    name: 'Lounge',
    topic: null,
    topic_html: null,
    avatar_url: null,
    room_kind: 'text',
    num_joined_members: 3,
    join_rule: 'public',
    state: null,
    via: { type: 'unknown' },
    ...overrides,
  };
}

function person(user_id: string, display_name: string): UserDirectoryEntryView {
  return { user_id, display_name, avatar_url: null, real_name: null, real_avatar_url: null };
}

async function openWith(text: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(FindOrJoinDialog);
  openFindOrJoin();
  await user.type(await screen.findByRole('textbox'), text);
  return user;
}

beforeEach(() => {
  core.rpc.account.searchUserDirectory.mockResolvedValue({ limited: false, results: [] });
});

afterEach(() => {
  findOrJoinState.open = false;
  vi.clearAllMocks();
});

test('previews a pasted address and joins it', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview());
  core.rpc.rooms.join.mockResolvedValue('!room:example.org');

  const user = await openWith('#lounge:example.org');
  expect(await screen.findByText('Lounge')).toBeInTheDocument();
  expect(screen.getByText('join.members:3')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'common.join' }));

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/rooms/!room%3Aexample.org');
  });
  expect(findOrJoinState.open).toBe(false);
});

test('opens a room the account is already in without joining again', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview({ state: 'joined' }));

  const user = await openWith('#lounge:example.org');
  await user.click(await screen.findByRole('button', { name: 'findOrJoin.open' }));

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('!room%3Aexample.org'));
  });
  expect(core.rpc.rooms.join).not.toHaveBeenCalled();
});

test('sends a knock room to its ask to join page', async () => {
  core.rpc.rooms.preview.mockResolvedValue(preview({ join_rule: 'knock' }));

  const user = await openWith('#lounge:example.org');
  await user.click(await screen.findByRole('button', { name: 'common.askToJoin' }));

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/rooms/%23lounge%3Aexample.org');
  });
  expect(core.rpc.rooms.join).not.toHaveBeenCalled();
});

test('still joins when the server gives no preview, and reports a failed join', async () => {
  core.rpc.rooms.preview.mockRejectedValue(new Error('no preview'));
  core.rpc.rooms.join.mockRejectedValue(new Error('forbidden'));

  const user = await openWith('#lounge:example.org');
  expect(
    await screen.findByText('findOrJoin.previewUnavailable:#lounge:example.org')
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'common.join' }));

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(findOrJoinState.open).toBe(true);
});

test('finds a person by name and opens a chat with them', async () => {
  core.rpc.account.searchUserDirectory.mockResolvedValue({
    limited: false,
    results: [person('@bob:example.org', 'Bob')],
  });
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');

  const user = await openWith('bob');
  await user.click(await screen.findByRole('button', { name: /Bob/ }));

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/direct/!dm%3Aexample.org');
  });
  expect(core.rpc.rooms.createDm).toHaveBeenCalledWith(
    expect.objectContaining({ user_id: '@bob:example.org' })
  );
});

test('offers a full user id the directory does not list', async () => {
  core.rpc.rooms.createDm.mockResolvedValue('!dm:example.org');

  const user = await openWith('@new:example.org');
  await user.keyboard('{Enter}');

  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '@new:example.org' })
    );
  });
});
