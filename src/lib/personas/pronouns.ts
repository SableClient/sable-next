import type { PronounView } from '#src/generated/PronounView';

export function parsePronouns(input: string): PronounView[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const match = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(entry);
      return {
        summary: match?.[1]?.trim() || entry,
        language: match?.[2]?.trim().toLowerCase() ?? null,
      };
    });
}

export function formatPronouns(pronouns: readonly PronounView[]): string {
  return pronouns
    .map(({ summary, language }) => (language ? `${summary} (${language})` : summary))
    .join(', ');
}
