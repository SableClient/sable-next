import { describe, expect, test, vi } from 'vitest';

import type { LoginFlowsView } from '#src/generated/protocol';

vi.mock('#lib/platform/deep-links.js', () => ({
  deliversDeepLinks: () => true,
}));

vi.mock('#lib/platform/external-auth.js', () => ({
  openExternalAuthUrl: vi.fn(() => Promise.resolve()),
}));

import { RedirectController } from './redirect-controller.svelte';

const flows: LoginFlowsView = {
  password: false,
  oidc: true,
  oidc_registration: true,
  sso: false,
  oauth_aware_preferred: true,
  sso_identity_providers: [],
};

describe('RedirectController', () => {
  test('starts only one provider login while a launch is pending', async () => {
    let resolveValidation: (value: LoginFlowsView) => void = () => {
      throw new Error('Validation was not started');
    };
    const validateHomeserver = vi.fn(
      () => new Promise<LoginFlowsView>((resolve) => (resolveValidation = resolve))
    );
    const startOidcLogin = vi.fn(() => Promise.resolve('https://auth.example.org/authorize'));
    const controller = new RedirectController({
      core: { startOidcLogin } as never,
      getHomeserver: () => 'matrix.example.org',
      getValidationError: () => null,
      validateHomeserver,
      onMarkLoggedIn: vi.fn(),
      onMarkOnboardingPending: vi.fn(),
      onNavigateLoginVerification: vi.fn(() => Promise.resolve()),
      onNavigateRegistrationRecovery: vi.fn(() => Promise.resolve()),
    });

    const first = controller.launch('oidc', undefined, 'login');
    const second = controller.launch('oidc', undefined, 'login');

    expect(validateHomeserver).toHaveBeenCalledOnce();

    resolveValidation(flows);
    await Promise.all([first, second]);

    expect(startOidcLogin).toHaveBeenCalledOnce();
  });
});
