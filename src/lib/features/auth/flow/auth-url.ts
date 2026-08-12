const AUTH_ROUTES = new Set(['login', 'register']);

export function homeserverFromAuthUrl(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  const routeIndex = segments.findIndex((segment) => AUTH_ROUTES.has(segment));
  const candidate = routeIndex < 0 ? undefined : segments[routeIndex + 1];

  if (!candidate || candidate === 'profile') return null;

  try {
    const homeserver = decodeURIComponent(candidate).trim();
    return homeserver && !homeserver.includes('/') ? homeserver : null;
  } catch {
    return null;
  }
}

export function registrationTokenFromAuthUrl(url: URL): string | null {
  if (!url.pathname.split('/').includes('register')) return null;

  for (const key of ['registration_token', 'registrationToken', 'token']) {
    const token = url.searchParams.get(key)?.trim();
    if (token) return token;
  }

  return null;
}
