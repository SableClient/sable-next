// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('$lib/core/context', () => ({
  useCoreClient: () => core,
}));

import MediaContent from './MediaContent.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
});

test.each([
  { kind: 'video' as const, selector: 'video' },
  { kind: 'audio' as const, selector: 'audio' },
  { kind: 'file' as const, selector: 'a[download="report.pdf"]' },
])('renders a $kind attachment from the original media', async ({ kind, selector }) => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MediaContent, {
    target: document.body,
    props: {
      kind,
      source: `mxc://example.org/${kind}`,
      mime: `${kind}/*`,
      body: 'report.pdf',
    },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.fetchMedia).toHaveBeenCalledWith(`mxc://example.org/${kind}`, 0, 0);
  expect(document.querySelector(selector)).not.toBeNull();
  await unmount(instance);
});
