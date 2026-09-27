import type { RoomSummary } from '#src/generated/protocol';

import type { Suggestion } from './autocomplete';
import { parseBotCommand, type BotCommand } from './bot-commands';

export type AdminCommand = {
  readonly name: string;
  readonly description: string;
  readonly restricted?: boolean;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly unknown[];
  readonly children?: readonly AdminCommand[];
};

export type AdminScope = 'adminRoom' | 'escaped' | null;

export const ADMIN_PREFIX = '!admin';

export async function loadAdminCommands(): Promise<readonly AdminCommand[]> {
  const catalog = await import('./admin-commands.json');
  return catalog.default.commands;
}

export function adminBot(userId: string): string {
  return `@conduit:${userId.slice(userId.indexOf(':') + 1)}`;
}

type CommandNode = { name: string; description: string; children: CommandNode[] };

export function adminCommandTree(commands: readonly BotCommand[]): readonly AdminCommand[] {
  const root: CommandNode[] = [];
  for (const command of commands) {
    const words = command.command.split(' ');
    let level = root;
    for (const [index, word] of words.entries()) {
      let node = level.find((candidate) => candidate.name === word);
      if (!node) {
        node = { name: word, description: '', children: [] };
        level.push(node);
      }
      if (index === words.length - 1) node.description = command.description ?? '';
      level = node.children;
    }
  }
  const sorted = (nodes: CommandNode[]): AdminCommand[] =>
    nodes
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((node) => ({ ...node, children: sorted(node.children) }));
  return sorted(root);
}

export function adminBotCommands(
  commands: readonly AdminCommand[],
  bot: string,
  scope: AdminScope
): BotCommand[] {
  const walk = (level: readonly AdminCommand[], path: readonly string[]): BotCommand[] =>
    level.flatMap((node) => {
      if (scope === 'escaped' && node.restricted) return [];
      const name = [...path, node.name];
      if (node.children) return walk(node.children, name);
      const command = parseBotCommand({
        sender: bot,
        sender_name: null,
        sender_avatar: null,
        content: {
          command: name.join(' '),
          aliases: (node.aliases ?? []).map((alias) => [...path, alias].join(' ')),
          description: node.description ? { 'm.text': [{ body: node.description }] } : undefined,
          parameters: node.parameters ?? [],
        },
      });
      return command ? [command] : [];
    });
  return walk(commands, []);
}

export function adminScope(
  roomId: string,
  rooms: readonly RoomSummary[],
  userId: string | null | undefined
): AdminScope {
  if (!userId) return null;

  const alias = `#admins:${userId.slice(userId.indexOf(':') + 1)}`;
  const adminRoom = rooms.find((room) => room.canonical_alias === alias);
  if (!adminRoom) return null;
  return adminRoom.room_id === roomId ? 'adminRoom' : 'escaped';
}

export function adminSuggestions(
  command: string,
  scope: AdminScope,
  commands: readonly AdminCommand[] | null
): Suggestion[] {
  if (!scope) return [];
  const prefix = scope === 'escaped' ? `\\${ADMIN_PREFIX}` : ADMIN_PREFIX;
  const words = command.split(' ');
  const head = words.shift() ?? '';

  if (words.length === 0) {
    if (!prefix.startsWith(head)) return [];
    return [{ id: prefix, insert: prefix, label: prefix, detail: null }];
  }
  if (head !== prefix) return [];

  const needle = words.pop() ?? '';
  let level: readonly AdminCommand[] | null | undefined = commands;
  for (const word of words) {
    level = level?.find((candidate) => candidate.name === word)?.children;
  }
  if (!level) return [];

  const path = [prefix, ...words].join(' ');
  return level
    .filter((candidate) => candidate.name.startsWith(needle))
    .filter((candidate) => scope === 'adminRoom' || !candidate.restricted)
    .map((candidate) => ({
      id: `${path} ${candidate.name}`,
      insert: candidate.name,
      label: candidate.name,
      detail: candidate.description,
    }));
}
