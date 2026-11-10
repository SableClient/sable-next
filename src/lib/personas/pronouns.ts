import type { PronounView } from '#src/generated/protocol';

import type { PronounPillLength, PronounPillLimit } from '#lib/settings/definitions.js';

export function parsePronouns(input: string): PronounView[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const prefixed = /^([a-z]{2,8}(?:-[a-z0-9]{1,8})*)\s*:\s*(.+)$/i.exec(entry);
      if (prefixed) return { summary: prefixed[2].trim(), language: prefixed[1].toLowerCase() };
      const match = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(entry);
      return {
        summary: match?.[1]?.trim() || entry,
        language: match?.[2]?.trim().toLowerCase() ?? null,
      };
    });
}

const DISPLAY_NAME_PRONOUNS = /\s*(?:\(([a-z]+(?:\/[a-z]+){1,2})\)|\[([a-z]+(?:\/[a-z]+){1,2})\])/i;

export function splitDisplayNamePronouns(name: string): {
  name: string;
  pronouns: PronounView[];
} {
  const match = DISPLAY_NAME_PRONOUNS.exec(name);
  if (match === null) return { name, pronouns: [] };
  const stripped = name.replace(match[0], '').trim();
  if (stripped === '') return { name, pronouns: [] };
  return { name: stripped, pronouns: [{ summary: match[1] || match[2], language: null }] };
}

const PLURALKIT_GROUP = /\s*[([]([^()[\]]+)[)\]]/gu;
const PLURALKIT_SET = /^[\p{L}\p{N}'_-]+(?:\/[\p{L}\p{N}'_-]+){1,3}$/u;

export function splitPluralkitNamePronouns(name: string): {
  name: string;
  pronouns: PronounView[];
} {
  const pronouns: PronounView[] = [];
  const stripped = name
    .replace(PLURALKIT_GROUP, (group: string, inner: string) => {
      const sets = inner.split(/[,;|]/u).map((entry) => entry.trim());
      if (!sets.every((entry) => PLURALKIT_SET.test(entry))) return group;
      pronouns.push(...sets.map((summary) => ({ summary, language: null })));
      return '';
    })
    .trim();
  return stripped === '' ? { name, pronouns: [] } : { name: stripped, pronouns };
}

export function withDisplayNamePronouns(
  pronouns: readonly PronounView[],
  fromName: readonly PronounView[]
): PronounView[] {
  const missing = fromName.filter(
    ({ summary }) =>
      !pronouns.some((pronoun) => pronoun.summary.toLowerCase() === summary.toLowerCase())
  );
  return [...pronouns, ...missing];
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

export function fittingPillCount(
  widths: readonly number[],
  overflowWidth: number,
  gap: number,
  available: number,
  forceOverflow = false
): number {
  let used = 0;
  let count = 0;
  for (const [index, width] of widths.entries()) {
    used += width + (index > 0 ? gap : 0);
    const needsOverflow = forceOverflow || index < widths.length - 1;
    const total = used + (needsOverflow ? gap + overflowWidth : 0);
    if (total <= available) count = index + 1;
  }
  return count;
}
