export function parseShortcodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry, index, all) => all.indexOf(entry) === index)
    : [];
}
