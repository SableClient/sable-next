const AFTER_LOGIN_KEY = 'sable-after-login-path';
const AUTH_SEGMENTS = new Set(['login', 'register', 'reset-password', 'setup']);
const ORIGIN = 'https://sable.invalid';

export function afterLoginPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/\p{Cc}/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return null;
  const segment = url.pathname.split('/')[1] ?? '';
  if (segment === '' || AUTH_SEGMENTS.has(segment)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberAfterLogin(url: Pick<URL, 'pathname' | 'search' | 'hash'>): void {
  const path = afterLoginPath(`${url.pathname}${url.search}${url.hash}`);
  if (path) storage()?.setItem(AFTER_LOGIN_KEY, path);
}

export function takeAfterLogin(fallback: string): string {
  const store = storage();
  const stored = store?.getItem(AFTER_LOGIN_KEY);
  store?.removeItem(AFTER_LOGIN_KEY);
  return (stored && afterLoginPath(stored)) ?? fallback;
}
