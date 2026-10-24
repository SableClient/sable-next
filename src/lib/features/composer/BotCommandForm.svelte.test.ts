// @vitest-environment happy-dom

import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import BotCommandForm from './BotCommandForm.svelte';
import { parseBotCommand, type BotCommand } from './bot-commands';

const command = parseBotCommand({
  sender: '@conduit:example.org',
  sender_name: null,
  sender_avatar: null,
  content: {
    command: 'users force-join-all-local-users',
    parameters: [
      {
        key: 'room_id',
        schema: {
          schema_type: 'union',
          variants: [
            { schema_type: 'primitive', type: 'room_id' },
            { schema_type: 'primitive', type: 'room_alias' },
          ],
        },
      },
    ],
  },
}) as BotCommand;

function room(room_id: string, canonical_alias: string): RoomListItemView {
  return { room_id, name: 'Lobby', canonical_alias, avatar_url: null } as RoomListItemView;
}

function emptyDrafts(command: BotCommand): Record<string, string> {
  return Object.fromEntries(command.parameters.map(({ key }) => [key, '']));
}

test('rooms sharing a canonical alias are offered once', () => {
  const { container } = renderWithTooltips(BotCommandForm, {
    command,
    drafts: emptyDrafts(command),
    members: [],
    rooms: [
      room('!old:example.org', '#lobby:example.org'),
      room('!new:example.org', '#lobby:example.org'),
    ],
    prefix: '!admin ',
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  });

  const values = [...container.querySelectorAll('datalist option')].map(
    (option) => (option as HTMLOptionElement).value
  );
  expect(values).toEqual(['!old:example.org', '#lobby:example.org', '!new:example.org']);
});
