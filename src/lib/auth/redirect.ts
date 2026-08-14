export type RedirectLoginType = 'oidc' | 'sso';

function hasSingleNonemptyParameter(url: URL, name: string): boolean {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0].length > 0;
}

export function redirectLoginType(callbackUrl: string): RedirectLoginType | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }

  if (hasSingleNonemptyParameter(url, 'loginToken')) return 'sso';
  const hasCode = hasSingleNonemptyParameter(url, 'code');
  const hasError = hasSingleNonemptyParameter(url, 'error');
  if (hasSingleNonemptyParameter(url, 'state') && hasCode !== hasError) {
    return 'oidc';
  }
  return null;
}

export function createRedirectUri(
  loginType: RedirectLoginType,
  baseUrl: string,
  nonce: string
): string {
  const url = new URL(baseUrl);
  if (loginType === 'sso') url.searchParams.set('sable_sso_state', nonce);
  return url.toString();
}

export function tauriRedirectUri(loginType: RedirectLoginType): string {
  return loginType === 'oidc' ? 'moe.sable.next:/login' : 'sable://login';
}

export function callbackChannelName(callbackUrl: string, windowName: string): string {
  const url = new URL(callbackUrl);
  const state = url.searchParams.get('state') ?? url.searchParams.get('sable_sso_state');
  return `sable-auth-callback:${state ?? windowName}`;
}

export function scrubbedCallbackPath(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  return `${url.pathname}${url.hash}`;
}
