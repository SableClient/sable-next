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
