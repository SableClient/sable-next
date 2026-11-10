import { expect, test } from 'vitest';

import { parseBridgeEvents } from './bridge-info';

const discord = {
  bridgebot: '@discordbot:example.org',
  creator: '@alice:example.org',
  protocol: { id: 'discord', displayname: 'Discord', avatar_url: 'mxc://example.org/logo' },
  network: { id: '1234', displayname: 'Guild', external_url: 'https://discord.com/channels/1234' },
  channel: { id: '5678', external_url: 'javascript:alert(1)' },
};

test('a bridge lists its service, network, chat and accounts', () => {
  expect(parseBridgeEvents([{ state_key: 'discord', content: discord }])).toEqual([
    {
      key: 'discord',
      protocol: { name: 'Discord', url: null, avatar: 'mxc://example.org/logo' },
      network: { name: 'Guild', url: 'https://discord.com/channels/1234', avatar: null },
      channel: { name: '5678', url: null, avatar: null },
      bot: '@discordbot:example.org',
      creator: '@alice:example.org',
    },
  ]);
});

test('a bridge sending both event types is listed once, a removed one not at all', () => {
  const bridges = parseBridgeEvents([
    { state_key: 'discord', content: discord },
    { state_key: 'discord', content: { protocol: { id: 'old' } } },
    { state_key: 'gone', content: {} },
    { state_key: 'irc', content: { protocol: { id: 'irc' } } },
  ]);

  expect(bridges.map((bridge) => bridge.protocol.name)).toEqual(['Discord', 'irc']);
});
