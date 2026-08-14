import { describe, expect, test } from 'vitest';

import {
  callbackChannelName,
  createRedirectUri,
  redirectLoginType,
  scrubbedCallbackPath,
  tauriRedirectUri,
} from './redirect';

describe('redirect authentication', () => {
  test('classifies only complete OAuth and SSO responses', () => {
    expect(redirectLoginType('https://next.sable.moe/login?code=code&state=state')).toBe('oidc');
    expect(redirectLoginType('https://next.sable.moe/login?error=denied&state=state')).toBe('oidc');
    expect(redirectLoginType('https://next.sable.moe/login?loginToken=token')).toBe('sso');
    expect(redirectLoginType('https://next.sable.moe/login?code=code')).toBeNull();
    expect(redirectLoginType('https://next.sable.moe/login?state=state')).toBeNull();
    expect(redirectLoginType('https://next.sable.moe/login?loginToken=')).toBeNull();
    expect(
      redirectLoginType('https://next.sable.moe/login?loginToken=one&loginToken=two')
    ).toBeNull();
    expect(
      redirectLoginType('https://next.sable.moe/login?code=code&error=denied&state=state')
    ).toBeNull();
    expect(redirectLoginType('not a URL')).toBeNull();
  });

  test('adds a correlation value only to legacy SSO', () => {
    expect(createRedirectUri('sso', 'https://next.sable.moe/login', 'nonce')).toBe(
      'https://next.sable.moe/login?sable_sso_state=nonce'
    );
    expect(createRedirectUri('oidc', 'https://next.sable.moe/login', 'nonce')).toBe(
      'https://next.sable.moe/login'
    );
    expect(createRedirectUri('oidc', 'moe.sable.next:/login', 'nonce')).toBe(
      'moe.sable.next:/login'
    );
  });

  test('uses valid native callback URI forms', () => {
    expect(tauriRedirectUri('oidc')).toBe('moe.sable.next:/login');
    expect(tauriRedirectUri('sso')).toBe('sable://login');
  });

  test('uses protocol state to isolate callback channels', () => {
    expect(callbackChannelName('https://next.sable.moe/login?code=code&state=oauth', 'popup')).toBe(
      'sable-auth-callback:oauth'
    );
    expect(
      callbackChannelName(
        'https://next.sable.moe/login?sable_sso_state=sso&loginToken=token',
        'popup'
      )
    ).toBe('sable-auth-callback:sso');
  });

  test('removes credentials from the callback location', () => {
    expect(scrubbedCallbackPath('https://next.sable.moe/login?code=code&state=state#section')).toBe(
      '/login#section'
    );
    expect(scrubbedCallbackPath('https://next.sable.moe/login?loginToken=token')).toBe('/login');
  });
});
