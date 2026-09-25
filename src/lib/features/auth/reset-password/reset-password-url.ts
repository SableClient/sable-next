import { resolve } from '$app/paths';

export function resetPasswordHref(homeserver: string): string {
  return resolve(`reset-password?server=${encodeURIComponent(homeserver.trim())}`);
}

export function loginHref(homeserver: string, defaultHomeserver: string): string {
  const server = homeserver.trim();
  if (!server || server === defaultHomeserver || /[/?#]/.test(server)) return resolve('login');
  return resolve('/(auth)/login/[homeserver]', { homeserver: encodeURIComponent(server) });
}
