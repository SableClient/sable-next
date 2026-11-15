const WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// Mirrors BLOCKED_LINK_SCHEMES in crates/sable-model/src/html.rs.
const BLOCKED_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'content:',
  'data:',
  'file:',
  'intent:',
  'jar:',
  'javascript:',
  'ms-msdt:',
  'ms-officecmd:',
  'mxc:',
  'search-ms:',
  'vbscript:',
  'view-source:',
  'tauri:',
  'sable-app:',
]);

export function isWebProtocol(protocol: string): boolean {
  return WEB_PROTOCOLS.has(protocol);
}

/** Whether a link may be handed to the OS once the user has confirmed it. */
export function isOpenableProtocol(protocol: string): boolean {
  return /^[a-z][a-z0-9+.-]*:$/.test(protocol) && !BLOCKED_PROTOCOLS.has(protocol);
}
