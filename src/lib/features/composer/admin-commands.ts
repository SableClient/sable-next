import type { RoomSummary } from '#src/generated/protocol';

import type { Suggestion } from './autocomplete';

export type AdminCommand = {
  readonly name: string;
  readonly description: string;
  readonly restricted?: boolean;
  readonly children?: readonly AdminCommand[];
};

export type AdminScope = 'adminRoom' | 'escaped' | null;

const PREFIX = '!admin';

export async function loadAdminCommands(): Promise<readonly AdminCommand[]> {
  const catalog = await import('./admin-commands.json');
  return catalog.default.commands;
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
  const prefix = scope === 'escaped' ? `\\${PREFIX}` : PREFIX;
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
