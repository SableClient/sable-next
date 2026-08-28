export function mimeExtension(mime: string | null): string | null {
  if (!mime) return null;
  const slash = mime.indexOf('/');
  if (slash === -1) return null;
  const subtype = mime
    .slice(slash + 1)
    .split(';')[0]
    .trim();
  return subtype || null;
}
