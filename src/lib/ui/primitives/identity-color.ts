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

const senderColors = [
  'var(--primary-main)',
  'var(--sec-main)',
  'var(--success-main)',
  'var(--warn-main)',
  'var(--crit-main)',
];

export function senderColor(sender: string | null): string {
  let hash = 0;
  for (const character of sender ?? '') hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const fallback = senderColors[Math.abs(hash) % senderColors.length];
  const variable = `--mx-uc-${(hashCode(sender) % 8) + 1}`;
  return `var(${variable}, ${fallback})`;
}
