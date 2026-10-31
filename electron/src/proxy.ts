// Chromium resolves names on a SOCKS5 proxy and reads `socks://` as SOCKS4.
export function coreProxy(value: string): string {
  if (/[;=]/.test(value)) {
    throw new Error(`per-scheme proxy rules are not supported: ${value}`);
  }
  const url = value.trim();
  if (url.startsWith('socks5://')) return `socks5h://${url.slice('socks5://'.length)}`;
  if (url.startsWith('socks://')) return `socks4://${url.slice('socks://'.length)}`;
  return url;
}
