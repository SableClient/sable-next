import type { PronounView } from '#src/generated/protocol';

import type { PronounPillLength, PronounPillLimit } from '#lib/settings/preferences.svelte.js';

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

const DEFAULT_VISIBLE_PRONOUNS = 3;

function primaryTag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}

export function preferredPronouns(
  pronouns: readonly PronounView[],
  language: string
): PronounView[] {
  const tag = primaryTag(language);
  const matching = pronouns.filter((pronoun) => primaryTag(pronoun.language ?? 'en') === tag);
  return matching.length > 0 ? matching : [...pronouns];
}

export function pronounPillLimit(setting: PronounPillLimit): number {
  return setting === 'all' ? Number.POSITIVE_INFINITY : Number(setting);
}

export function pronounPillLength(setting: PronounPillLength): number {
  return setting === 'all' ? Number.POSITIVE_INFINITY : Number(setting);
}

export function clampPronoun(summary: string, maxLength: number): string {
  return summary.length > maxLength ? `${summary.slice(0, Math.max(1, maxLength - 1))}…` : summary;
}

export function visiblePronouns(
  pronouns: readonly PronounView[],
  {
    language,
    filterByLanguage = true,
    limit = DEFAULT_VISIBLE_PRONOUNS,
    maxLength = Number.POSITIVE_INFINITY,
  }: { language: string; filterByLanguage?: boolean; limit?: number; maxLength?: number }
): { visible: PronounView[]; overflow: PronounView[] } {
  const preferred = filterByLanguage ? preferredPronouns(pronouns, language) : [...pronouns];
  const clamped = preferred.map((pronoun) => ({
    ...pronoun,
    summary: clampPronoun(pronoun.summary, maxLength),
  }));
  return { visible: clamped.slice(0, limit), overflow: clamped.slice(limit) };
}
