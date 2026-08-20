const AUTH_ROUTES = new Set(['login', 'register']);

type AuthUrl = Pick<URL, 'pathname'> & {
  searchParams: Pick<URLSearchParams, 'get'>;
};

export function homeserverFromAuthUrl(url: AuthUrl, routeId: string | null): string | null {
  const queryHomeserver = url.searchParams.get('server')?.trim();
  if (queryHomeserver) return queryHomeserver;
  // `/login/verify`, `/register/recovery` and `/register/profile` sit in the
  // same segment a homeserver would.
  if (!routeId?.endsWith('/[homeserver]')) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const routeIndex = segments.findIndex((segment) => AUTH_ROUTES.has(segment));
  const candidate = routeIndex < 0 ? undefined : segments[routeIndex + 1];

  if (!candidate) return null;

  try {
    const homeserver = decodeURIComponent(candidate).trim();
    return homeserver && !homeserver.includes('/') ? homeserver : null;
  } catch {
    return null;
  }
}

export function registrationTokenFromAuthUrl(url: AuthUrl): string | null {
  if (!url.pathname.split('/').includes('register')) return null;

  for (const key of ['registration_token', 'registrationToken', 'token']) {
    const token = url.searchParams.get(key)?.trim();
    if (token) return token;
  }

  return null;
}
