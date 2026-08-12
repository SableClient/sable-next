import type { LoginFlowsView } from '@/generated/LoginFlowsView';

export type RegistrationMethod = 'oidc' | 'sso' | 'password';

export const REGISTRATION_METHOD_ORDER: RegistrationMethod[] = ['oidc', 'sso', 'password'];

export const LEGACY_REGISTRATION_FALLBACK: LoginFlowsView = {
  password: false,
  oidc: false,
  oidc_registration: false,
  sso: false,
  oauth_aware_preferred: false,
  sso_identity_providers: [],
};

export function registrationMethodAvailable(
  flows: LoginFlowsView,
  method: RegistrationMethod,
  uiaaRegistrationAvailable: boolean
): boolean {
  if (flows.oauth_aware_preferred) {
    if (method === 'oidc') return flows.oidc_registration;
    if (method === 'sso') return flows.sso && !flows.oidc_registration;
    return false;
  }
  if (method === 'oidc') return flows.oidc_registration;
  if (method === 'password') return uiaaRegistrationAvailable;
  return flows.sso;
}
