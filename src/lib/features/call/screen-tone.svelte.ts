import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-call-toned-screens';

function parse(parsed: unknown): string[] {
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const toned = $state<{ users: string[] }>({ users: readJson(STORAGE_KEY, parse, []) });

export function screenToned(userId: string): boolean {
  return toned.users.includes(userId);
}

export function setScreenToned(userId: string, on: boolean): void {
  toned.users = on
    ? [...toned.users.filter((user) => user !== userId), userId]
    : toned.users.filter((user) => user !== userId);
  writeJson(STORAGE_KEY, toned.users);
}
