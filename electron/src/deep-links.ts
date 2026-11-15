// Keep callback schemes aligned with the builder configs and nativeRedirectUri.
export function deepLinkSchemes(identifier: string): string[] {
  return identifier === 'moe.sable.client' || identifier === 'moe.sable.client.sandboxed'
    ? ['moe.sable.app', 'sable', 'matrix']
    : ['moe.sable.next', 'matrix'];
}

export function deepLinksIn(argv: string[], schemes: string[]): string[] {
  return argv.filter((arg) => {
    try {
      const url = new URL(arg);
      return (
        schemes.includes(url.protocol.slice(0, -1)) ||
        (url.protocol === 'https:' &&
          ['link.sable.moe', 'matrix.to'].includes(url.host) &&
          url.hash.startsWith('#/'))
      );
    } catch {
      return false;
    }
  });
}
