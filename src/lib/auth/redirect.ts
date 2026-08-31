export type RedirectLoginType = 'oidc' | 'sso';

const RESPONSE_PARAMETERS = ['code', 'state', 'error', 'loginToken'];

function carriesResponse(parameters: URLSearchParams): boolean {
  return RESPONSE_PARAMETERS.some((name) => parameters.has(name));
}

function callbackParameters(url: URL): URLSearchParams {
  const fragment = new URLSearchParams(url.hash.slice(1));
  return carriesResponse(fragment) ? fragment : url.searchParams;
}

function hasSingleNonemptyParameter(parameters: URLSearchParams, name: string): boolean {
  const values = parameters.getAll(name);
  return values.length === 1 && values[0].length > 0;
}

export function redirectLoginType(callbackUrl: string): RedirectLoginType | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }

  const parameters = callbackParameters(url);
  if (hasSingleNonemptyParameter(parameters, 'loginToken')) return 'sso';
  const hasCode = hasSingleNonemptyParameter(parameters, 'code');
  const hasError = hasSingleNonemptyParameter(parameters, 'error');
  if (hasSingleNonemptyParameter(parameters, 'state') && hasCode !== hasError) {
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
  const parameters = callbackParameters(url);
  const state = parameters.get('state') ?? url.searchParams.get('sable_sso_state');
  return `sable-auth-callback:${state ?? windowName}`;
}

export function scrubbedCallbackPath(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  const hash = carriesResponse(new URLSearchParams(url.hash.slice(1))) ? '' : url.hash;
  return `${url.pathname}${hash}`;
}
