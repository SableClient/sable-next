import { describe, expect, it } from 'vitest';
import { homeserverFromAuthUrl, registrationTokenFromAuthUrl } from './auth-url';

describe('auth URL prefill', () => {
  it('reads homeservers from login and registration paths', () => {
    expect(homeserverFromAuthUrl(new URL('https://sable.test/login/sable.moe'))).toBe('sable.moe');
    expect(homeserverFromAuthUrl(new URL('https://sable.test/register/sable.moe'))).toBe(
      'sable.moe'
    );
  });

  it('reads a homeserver URL from the query string', () => {
    expect(
      homeserverFromAuthUrl(
        new URL('https://sable.test/login?server=http%3A%2F%2Flocalhost%3A8008')
      )
    ).toBe('http://localhost:8008');
  });

  it('does not treat profile as a homeserver', () => {
    expect(homeserverFromAuthUrl(new URL('https://sable.test/register/profile'))).toBeNull();
  });

  it('accepts registration token aliases only on registration routes', () => {
    expect(
      registrationTokenFromAuthUrl(
        new URL('https://sable.test/register/sable.moe?registration_token=invite-123')
      )
    ).toBe('invite-123');
    expect(
      registrationTokenFromAuthUrl(
        new URL('https://sable.test/register?registrationToken=invite-456')
      )
    ).toBe('invite-456');
    expect(
      registrationTokenFromAuthUrl(new URL('https://sable.test/login?token=not-an-invite'))
    ).toBeNull();
  });
});
