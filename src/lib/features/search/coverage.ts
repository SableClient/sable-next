import type { SearchCoverageView } from '#src/generated/protocol';

type Translate = (key: string, options?: Record<string, unknown>) => string;

function rounded(count: number): number {
  if (count < 100) return count;
  const step = 10 ** (Math.floor(Math.log10(count)) - 1);
  return Math.floor(count / step) * step;
}

export function coverageMessage(
  coverage: SearchCoverageView | null,
  unavailable: boolean,
  t: Translate
): string {
  if (!coverage) return unavailable ? t('search.coverageUnknown') : '';

  const counted = t('search.coverageCount', { count: rounded(coverage.documents) });

  switch (coverage.state) {
    case 'indexing':
      return `${counted} ${t('search.coverageIndexing')}`;
    case 'partial':
      return `${counted} ${t('search.coveragePartial', { count: coverage.rooms_failed })}`;
    case 'stopped':
      return `${counted} ${t('search.coverageStopped')}`;
    case 'complete':
      return `${counted} ${t('search.coverageComplete')}`;
  }
}
