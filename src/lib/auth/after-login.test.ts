// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';

import { afterLoginPath, rememberAfterLogin, takeAfterLogin } from './after-login';

describe('after-login path', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test('keeps a same-origin app path with its query and hash', () => {
    expect(afterLoginPath('/rooms/!room:example.org')).toBe('/rooms/!room:example.org');
    expect(afterLoginPath('/settings/account?tab=1#email')).toBe('/settings/account?tab=1#email');
    expect(afterLoginPath('/to/%23room:example.org')).toBe('/to/%23room:example.org');
  });

  test('rejects absolute and protocol-relative URLs', () => {
    expect(afterLoginPath('https://evil.example/rooms')).toBeNull();
    expect(afterLoginPath('javascript:alert(1)')).toBeNull();
    expect(afterLoginPath('//evil.example/rooms')).toBeNull();
    expect(afterLoginPath('/\\evil.example')).toBeNull();
    expect(afterLoginPath('/..//evil.example')).toBeNull();
    expect(afterLoginPath('/\t/evil.example')).toBeNull();
    expect(afterLoginPath('rooms')).toBeNull();
    expect(afterLoginPath('')).toBeNull();
  });

  test('rejects the root and every auth route', () => {
    expect(afterLoginPath('/')).toBeNull();
    expect(afterLoginPath('/login')).toBeNull();
    expect(afterLoginPath('/login?reauth=a1')).toBeNull();
    expect(afterLoginPath('/login/verify')).toBeNull();
    expect(afterLoginPath('/login/http:/host:8008')).toBeNull();
    expect(afterLoginPath('/register/profile')).toBeNull();
    expect(afterLoginPath('/reset-password')).toBeNull();
    expect(afterLoginPath('/./login')).toBeNull();
  });

  test('stores the requested page once and falls back afterwards', () => {
    rememberAfterLogin(new URL('https://app.example/rooms/!room:example.org?event=$e'));
    expect(takeAfterLogin('/rooms')).toBe('/rooms/!room:example.org?event=$e');
    expect(takeAfterLogin('/rooms')).toBe('/rooms');
  });

  test('ignores an auth route and a tampered stored value', () => {
    rememberAfterLogin(new URL('https://app.example/login'));
    expect(takeAfterLogin('/rooms')).toBe('/rooms');
    sessionStorage.setItem('sable-after-login-path', '//evil.example');
    expect(takeAfterLogin('/rooms')).toBe('/rooms');
  });
});
