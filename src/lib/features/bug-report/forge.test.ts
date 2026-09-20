// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import { forgeIssueUrl, openForgeIssueUrl, searchForgeIssues } from './forge.js';

const { openExternalUrl, opensExternalUrls } = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(url: string) => Promise<void>>(),
  opensExternalUrls: vi.fn(() => false),
}));

vi.mock('#lib/platform/external-links.js', () => ({ openExternalUrl, opensExternalUrls }));

test('a bug report prefills the template fields Forgejo reads', () => {
  const url = new URL(
    forgeIssueUrl('bug', '  Timeline jumps  ', {
      description: 'It jumps',
      reproduction: '',
      'expected-behavior': 'It stays',
    })
  );

  expect(url.origin + url.pathname).toBe('https://git.sable.moe/SableClient/sable-next/issues/new');
  expect(url.searchParams.get('template')).toBe('.github/ISSUE_TEMPLATE/bug_report.yml');
  expect(url.searchParams.get('title')).toBe('Timeline jumps');
  expect(url.searchParams.get('field:description')).toBe('It jumps');
  expect(url.searchParams.get('field:expected-behavior')).toBe('It stays');
  expect(url.searchParams.has('field:reproduction')).toBe(false);
});

test('a feature request uses the other template', () => {
  const url = new URL(forgeIssueUrl('feature', 'Pinned rooms', { problem: 'Too much scrolling' }));

  expect(url.searchParams.get('template')).toBe('.github/ISSUE_TEMPLATE/feature_request.yml');
  expect(url.searchParams.get('field:problem')).toBe('Too much scrolling');
});

test('a failed search yields no suggestions rather than throwing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

  await expect(searchForgeIssues('timeline', new AbortController().signal)).resolves.toEqual([]);

  vi.unstubAllGlobals();
});

test('the shell opens the issue, and the browser takes over when it refuses', async () => {
  const open = vi.fn();
  vi.stubGlobal('open', open);
  opensExternalUrls.mockReturnValue(true);
  openExternalUrl.mockRejectedValueOnce(new Error('no opener'));

  await openForgeIssueUrl('https://git.sable.moe/issue');
  expect(open).toHaveBeenCalledWith('https://git.sable.moe/issue', '_blank', 'noopener,noreferrer');

  openExternalUrl.mockResolvedValueOnce(undefined);
  await openForgeIssueUrl('https://git.sable.moe/issue');
  expect(open).toHaveBeenCalledOnce();

  vi.unstubAllGlobals();
});
