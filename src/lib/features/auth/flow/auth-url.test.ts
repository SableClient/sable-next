import { describe, expect, it } from 'vitest';
import { homeserverFromAuthUrl, registrationTokenFromAuthUrl } from './auth-url';

function prefilled(path: string, routeId: string): string | null {
  return homeserverFromAuthUrl(new URL(path, 'https://sable.test'), `/(auth)${routeId}`);
}

describe('auth URL prefill', () => {
  it('reads homeservers from login and registration paths', () => {
    expect(prefilled('/login/sable.moe', '/login/[homeserver]')).toBe('sable.moe');
    expect(prefilled('/register/sable.moe', '/register/[homeserver]')).toBe('sable.moe');
  });

  it('reads a homeserver URL from the query string', () => {
    expect(prefilled('/login?server=http%3A%2F%2Flocalhost%3A8008', '/login')).toBe(
      'http://localhost:8008'
    );
  });

  it('does not treat static auth sub-routes as a homeserver', () => {
    expect(prefilled('/login/verify', '/login/verify')).toBeNull();
    expect(prefilled('/register/recovery', '/register/recovery')).toBeNull();
    expect(prefilled('/register/profile', '/register/profile')).toBeNull();
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
