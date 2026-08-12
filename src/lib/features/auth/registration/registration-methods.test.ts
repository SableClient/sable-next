import { describe, expect, it } from 'vitest';
import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import { registrationMethodAvailable } from './registration-methods';

function flows(overrides: Partial<LoginFlowsView> = {}): LoginFlowsView {
  return {
    password: false,
    oidc: false,
    oidc_registration: false,
    sso: false,
    oauth_aware_preferred: false,
    sso_identity_providers: [],
    ...overrides,
  };
}

describe('registration method availability', () => {
  it('shows legacy registration only after UIAA discovery succeeds', () => {
    expect(registrationMethodAvailable(flows(), 'password', true)).toBe(true);
    expect(registrationMethodAvailable(flows(), 'password', false)).toBe(false);
  });

  it('prefers native OAuth create over its compatibility SSO flow', () => {
    const advertised = flows({
      oauth_aware_preferred: true,
      sso: true,
      oidc: true,
      oidc_registration: true,
    });
    expect(registrationMethodAvailable(advertised, 'oidc', true)).toBe(true);
    expect(registrationMethodAvailable(advertised, 'sso', true)).toBe(false);
    expect(registrationMethodAvailable(advertised, 'password', true)).toBe(false);
  });

  it('does not expose password registration when OAuth-aware discovery is preferred', () => {
    const advertised = flows({ oauth_aware_preferred: true, password: true });
    expect(registrationMethodAvailable(advertised, 'password', true)).toBe(false);
    expect(registrationMethodAvailable(advertised, 'password', false)).toBe(false);
  });
});
