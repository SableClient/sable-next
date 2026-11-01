// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPreviewView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) =>
    path.replace('/(app)', '').replace(/\[([^\]]+)\]/g, (_, key: string) => params[key] ?? key),
}));
vi.mock('#lib/core/context.js');

import { goto } from '$app/navigation';
import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.rooms, {
  join: vi.fn<(params: { address: string; via: string[] }) => Promise<string>>(),
  preview: vi.fn<() => Promise<RoomPreviewView>>(),
});

import JoinAddressForm from './JoinAddressForm.svelte';

function preview(join_rule: RoomPreviewView['join_rule']): RoomPreviewView {
  return {
    room_id: '!room:example.org',
    canonical_alias: '#knock:example.org',
    name: 'Knock room',
    topic: null,
    topic_html: null,
    avatar_url: null,
    room_kind: 'text',
    num_joined_members: 3,
    join_rule,
    state: null,
    via: { type: 'unknown' },
  };
}

async function submitAddress(): Promise<void> {
  const user = userEvent.setup();
  render(JoinAddressForm);
  await user.type(screen.getByRole('textbox'), '#knock:example.org');
  await user.click(screen.getByRole('button', { name: 'Join' }));
}

afterEach(() => {
  vi.clearAllMocks();
});

test('opens the ask to join page when the room requires knocking', async () => {
  vi.mocked(core.rpc.rooms.join).mockRejectedValue(new Error('forbidden'));
  vi.mocked(core.rpc.rooms.preview).mockResolvedValue(preview('knock'));

  await submitAddress();

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('%23knock%3Aexample.org'));
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('reports the failure when the room is not knockable', async () => {
  vi.mocked(core.rpc.rooms.join).mockRejectedValue(new Error('forbidden'));
  vi.mocked(core.rpc.rooms.preview).mockResolvedValue(preview('invite'));

  await submitAddress();

  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(goto).not.toHaveBeenCalled();
});
