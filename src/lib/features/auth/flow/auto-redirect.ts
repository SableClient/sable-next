import type { LoginFlowsView } from '#src/generated/protocol';

export type AutoRedirectStep = 'login' | 'registration';
export type AutoRedirectTarget = { type: 'oidc' } | { type: 'sso'; id?: string };

export function shouldAutoRedirect(
  policy: 'immediate' | 'loginPage' | null,
  flows: LoginFlowsView | null,
  step: AutoRedirectStep,
  alreadyTried: boolean
): AutoRedirectTarget | null {
  if (!policy || !flows || alreadyTried || flows.password) return null;
  if (policy === 'loginPage' && step !== 'login') return null;

  const targets: AutoRedirectTarget[] = [];
  if (flows.oidc) targets.push({ type: 'oidc' });
  if (flows.sso && !(flows.oauth_aware_preferred && flows.oidc)) {
    if (flows.sso_identity_providers.length === 0) targets.push({ type: 'sso' });
    else
      for (const provider of flows.sso_identity_providers)
        targets.push({ type: 'sso', id: provider.id });
  }
  return targets.length === 1 ? targets[0] : null;
}
