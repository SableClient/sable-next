import type { LoginIdentifier } from '#src/generated/protocol';

const USER_ID = /^@[^\s:]+:((?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function userIdServer(input: string): string | null {
  return USER_ID.exec(input.trim())?.[1]?.toLowerCase() ?? null;
}

export function loginIdentifier(input: string): LoginIdentifier {
  const value = input.trim();
  if (!value.startsWith('@') && EMAIL.test(value)) return { kind: 'email', address: value };
  return { kind: 'user', user: value };
}

export function sameServer(homeserver: string, server: string): boolean {
  const bare = homeserver
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return bare === server;
}
