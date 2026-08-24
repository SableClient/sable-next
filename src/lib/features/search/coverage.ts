import type { SearchCoverageView } from '#src/generated/SearchCoverageView';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function coverageMessage(
  coverage: SearchCoverageView | null,
  unavailable: boolean,
  t: Translate
): string {
  if (!coverage) return unavailable ? t('search.coverageUnknown') : '';

  const counted = t('search.coverageCount', { count: coverage.documents });

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
