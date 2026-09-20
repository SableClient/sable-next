import { openExternalUrl, opensExternalUrls } from '#lib/platform/external-links.js';

export type ReportType = 'bug' | 'feature';

export interface ForgeIssue {
  number: number;
  title: string;
  html_url: string;
}

const FORGE_ORIGIN = 'https://git.sable.moe';
const FORGE_REPO = 'SableClient/sable-next';

const TEMPLATES: Record<ReportType, string> = {
  bug: '.github/ISSUE_TEMPLATE/bug_report.yml',
  feature: '.github/ISSUE_TEMPLATE/feature_request.yml',
};

const forgeIssuesUrl = `${FORGE_ORIGIN}/${FORGE_REPO}/issues`;

export function forgeIssueUrl(
  type: ReportType,
  title: string,
  fields: Record<string, string>
): string {
  const params = new globalThis.URLSearchParams({ template: TEMPLATES[type], title: title.trim() });
  for (const [id, value] of Object.entries(fields)) {
    if (value.trim() !== '') params.set(`field:${id}`, value);
  }
  return `${forgeIssuesUrl}/new?${params}`;
}

export async function searchForgeIssues(query: string, signal: AbortSignal): Promise<ForgeIssue[]> {
  const params = new globalThis.URLSearchParams({
    q: query,
    state: 'open',
    type: 'issues',
    limit: '5',
  });
  const response = await fetch(`${FORGE_ORIGIN}/api/v1/repos/${FORGE_REPO}/issues?${params}`, {
    signal,
  });
  if (!response.ok) return [];
  return (await response.json()) as ForgeIssue[];
}

export async function openForgeIssueUrl(url: string): Promise<void> {
  if (opensExternalUrls()) {
    const opened = await openExternalUrl(url).then(
      () => true,
      () => false
    );
    if (opened) return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
