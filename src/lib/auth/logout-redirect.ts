import type { CoreClient } from '#lib/core/client.svelte.js';
import { logoutRedirectUrl } from '#lib/deployment/policy.js';

export function redirectAfterLogout(
  core: Pick<CoreClient, 'accounts'>,
  redirectUrl?: string | null
): void {
  const url = redirectUrl === undefined ? logoutRedirectUrl() : redirectUrl;
  if (url && core.accounts.length === 0) window.location.assign(url);
}
