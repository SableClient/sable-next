import { describe, expect, it } from 'vitest';

import type { LoginFlowsView, SsoIdentityProviderView } from '#src/generated/protocol';

import { shouldAutoRedirect } from './auto-redirect';

function flows(overrides: Partial<LoginFlowsView> = {}): LoginFlowsView {
  return {
    password: false,
    oidc: false,
    oidc_registration: false,
    qr_login: false,
    sso: false,
    oauth_aware_preferred: false,
    sso_identity_providers: [],
    ...overrides,
  };
}

function provider(id: string): SsoIdentityProviderView {
  return { id, name: id, icon: null, brand: null };
}

describe('shouldAutoRedirect', () => {
  it('never redirects without a policy, flows or after an attempt', () => {
    expect(shouldAutoRedirect(null, flows({ sso: true }), 'login', false)).toBeNull();
    expect(shouldAutoRedirect('immediate', null, 'login', false)).toBeNull();
    expect(shouldAutoRedirect('immediate', flows({ sso: true }), 'login', true)).toBeNull();
  });

  it('redirects to the only SSO or OIDC option', () => {
    expect(shouldAutoRedirect('immediate', flows({ sso: true }), 'login', false)).toEqual({
      type: 'sso',
    });
    expect(shouldAutoRedirect('immediate', flows({ oidc: true }), 'login', false)).toEqual({
      type: 'oidc',
    });
    expect(
      shouldAutoRedirect(
        'immediate',
        flows({ sso: true, sso_identity_providers: [provider('oidc-acme')] }),
        'login',
        false
      )
    ).toEqual({ type: 'sso', id: 'oidc-acme' });
  });

  it('shows the page when the choice is ambiguous or a password is offered', () => {
    expect(shouldAutoRedirect('immediate', flows(), 'login', false)).toBeNull();
    expect(
      shouldAutoRedirect('immediate', flows({ sso: true, password: true }), 'login', false)
    ).toBeNull();
    expect(
      shouldAutoRedirect('immediate', flows({ sso: true, oidc: true }), 'login', false)
    ).toBeNull();
    expect(
      shouldAutoRedirect(
        'immediate',
        flows({
          sso: true,
          sso_identity_providers: [provider('a'), provider('b')],
        }),
        'login',
        false
      )
    ).toBeNull();
  });

  it('prefers native OAuth over its compatibility SSO flow', () => {
    expect(
      shouldAutoRedirect(
        'immediate',
        flows({ sso: true, oidc: true, oauth_aware_preferred: true }),
        'login',
        false
      )
    ).toEqual({ type: 'oidc' });
  });

  it('waits for the login step under the loginPage policy', () => {
    const sso = flows({ sso: true });
    expect(shouldAutoRedirect('loginPage', sso, 'registration', false)).toBeNull();
    expect(shouldAutoRedirect('loginPage', sso, 'login', false)).toEqual({ type: 'sso' });
    expect(shouldAutoRedirect('immediate', sso, 'registration', false)).toEqual({ type: 'sso' });
  });
});
