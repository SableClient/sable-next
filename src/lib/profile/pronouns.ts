export interface PronounSet {
  summary: string;
  language?: string;
}

const MAX_SUMMARY = 16;
export const MAX_PRONOUN_INPUT = 128;

export function pronounSets(text: string): PronounSet[] {
  return text
    .slice(0, MAX_PRONOUN_INPUT)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      if (colon === -1) return { summary: entry.slice(0, MAX_SUMMARY), language: 'en' };
      return {
        summary: entry
          .slice(colon + 1)
          .trim()
          .slice(0, MAX_SUMMARY),
        language: entry.slice(0, colon).trim().toLowerCase() || 'en',
      };
    });
}

export function pronounText(
  sets: readonly { summary: string; language?: string | null }[]
): string {
  return sets
    .map(({ summary, language }) => `${language ? `${language}:` : ''}${summary}`)
    .join(', ');
}
