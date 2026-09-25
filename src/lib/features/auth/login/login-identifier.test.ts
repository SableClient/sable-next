import { describe, expect, it } from 'vitest';
import { loginIdentifier, sameServer, userIdServer } from './login-identifier';

describe('login identifier', () => {
  it('reads the server of a full Matrix ID', () => {
    expect(userIdServer(' @alice:Example.org ')).toBe('example.org');
    expect(userIdServer('@alice:localhost:8448')).toBe('localhost:8448');
    expect(userIdServer('@alice:[::1]:8448')).toBe('[::1]:8448');
  });

  it('finds no server in a localpart, an email or a partial ID', () => {
    expect(userIdServer('alice')).toBeNull();
    expect(userIdServer('alice@example.org')).toBeNull();
    expect(userIdServer('@alice')).toBeNull();
    expect(userIdServer('@alice:')).toBeNull();
    expect(userIdServer('@alice:example.org/path')).toBeNull();
  });

  it('sends an email address as a third-party identifier', () => {
    expect(loginIdentifier(' alice@example.org ')).toEqual({
      kind: 'email',
      address: 'alice@example.org',
    });
  });

  it('sends a localpart or a Matrix ID as a user identifier', () => {
    expect(loginIdentifier('alice')).toEqual({ kind: 'user', user: 'alice' });
    expect(loginIdentifier('@alice:example.org')).toEqual({
      kind: 'user',
      user: '@alice:example.org',
    });
  });

  it('compares a homeserver entry against a server name', () => {
    expect(sameServer('https://Example.org/', 'example.org')).toBe(true);
    expect(sameServer('example.org', 'example.org')).toBe(true);
    expect(sameServer('matrix.example.org', 'example.org')).toBe(false);
  });
});
