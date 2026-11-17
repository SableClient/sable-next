export function spellCheckerLanguages(preferred: string[], available: string[]): string[] {
  const supported = new Set(available);
  const picked: string[] = [];
  for (const language of preferred) {
    const base = language.split('-')[0];
    if (picked.some((dictionary) => dictionary.split('-')[0] === base)) continue;
    const fallback = base === 'en' && language !== 'en' ? 'en-GB' : base;
    const match = [language, fallback].find((candidate) => supported.has(candidate));
    if (match) picked.push(match);
  }
  return picked;
}
