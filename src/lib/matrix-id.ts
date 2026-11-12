export function localpartOf(id: string): string {
  const name = id.startsWith('@') ? id.slice(1) : id;
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(0, colon);
}

export function serverNameOf(id: string): string {
  const colon = id.indexOf(':');
  return colon === -1 ? '' : id.slice(colon + 1);
}
