// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core } from '#lib/core/__mocks__/context.js';

import RoomBridgesSettings from './RoomBridgesSettings.svelte';

const room = { room_id: '!room:example.org' } as RoomListItemView;
const eventsRaw = vi.fn<(params: { event_type: string }) => Promise<unknown[]>>();
Object.assign(core.rpc.room_state, { eventsRaw });

test('lists the bridge with its network, chat link and accounts', async () => {
  eventsRaw.mockImplementation(({ event_type }) =>
    Promise.resolve(
      event_type === 'm.bridge'
        ? [
            {
              state_key: 'discord',
              content: {
                bridgebot: '@discordbot:example.org',
                creator: '@alice:example.org',
                protocol: { id: 'discord', displayname: 'Discord' },
                network: { id: '1234', displayname: 'Guild' },
                channel: {
                  id: '5678',
                  displayname: 'general',
                  external_url: 'https://discord.com/channels/1234/5678',
                },
              },
            },
          ]
        : []
    )
  );
  render(RoomBridgesSettings, { room });

  const section = await screen.findByRole('region', { name: 'Discord' });
  expect(within(section).getByText('Guild')).toBeInTheDocument();
  expect(within(section).getByText('@discordbot:example.org')).toBeInTheDocument();
  expect(within(section).getByText('@alice:example.org')).toBeInTheDocument();
  expect(within(section).getByRole('link', { name: 'room.bridgeOpen' })).toHaveAttribute(
    'href',
    'https://discord.com/channels/1234/5678'
  );
  expect(eventsRaw).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_type: 'uk.half-shot.bridge',
    state_key: null,
  });
});

test('says so when the room gives no bridge details or the state cannot be read', async () => {
  eventsRaw.mockRejectedValue(new Error('offline'));
  render(RoomBridgesSettings, { room });

  expect(await screen.findByText('room.bridgesEmpty')).toBeInTheDocument();
});
