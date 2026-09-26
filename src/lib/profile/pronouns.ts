export interface PronounSet {
  summary: string;
  language?: string;
}

export function pronounSets(text: string): PronounSet[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(entry);
      return {
        summary: match?.[1]?.trim() || entry,
        ...(match?.[2] ? { language: match[2] } : {}),
      };
    });
}

export function pronounText(
  sets: readonly { summary: string; language?: string | null }[]
): string {
  return sets
    .map(({ summary, language }) => `${summary}${language ? ` (${language})` : ''}`)
    .join(', ');
}
