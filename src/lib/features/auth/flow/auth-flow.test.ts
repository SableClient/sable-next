import { describe, expect, it } from 'vitest';
import { LOGGED_IN_MARKER, readReturningUser } from './auth-flow.svelte';

describe('auth flow state helpers', () => {
  it('restores the returning-user marker', () => {
    const storage = {
      getItem: (key: string) => (key === LOGGED_IN_MARKER ? 'true' : null),
    } as Storage;
    expect(readReturningUser(storage)).toBe(true);
  });

  it('fails closed when no browser storage is available', () => {
    expect(readReturningUser(undefined)).toBe(false);
  });
});
