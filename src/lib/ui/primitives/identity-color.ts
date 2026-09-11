function hashCode(id: string | null | undefined): number {
  let hash = 0;
  if (id === null || id === undefined || id.length === 0) return hash;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.trunc((hash << 5) - hash + (id.codePointAt(index) ?? 0));
  }
  return Math.abs(hash);
}

export function identityColor(id: string | null | undefined): string {
  return `hsl(${hashCode(id) % 360}, 65%, 80%)`;
}
