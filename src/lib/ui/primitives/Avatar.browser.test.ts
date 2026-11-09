import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const { core } = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => core };
});

import { core } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import Avatar from './Avatar.svelte';

// Two frames, alternating red and blue, with an infinite loop.
const GIF = Uint8Array.from(
  atob(
    'R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw=='
  ),
  (char) => char.charCodeAt(0)
);

afterEach(() => {
  core.fetchMedia.mockReset();
  preferences.autoplayGifs = true;
  vi.restoreAllMocks();
});

function recordStills(): Set<string> {
  const stills = new Set<string>();
  const create = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
    const url = create(object);
    if (object instanceof Blob && object.type === 'image/webp') stills.add(url);
    return url;
  });
  return stills;
}

test.each(['thumbnail', 'encrypted', 'local', 'original', 'named-gif'])(
  'animated %s avatars play only on hover',
  async (kind) => {
    core.fetchMedia.mockResolvedValue(GIF);
    preferences.autoplayGifs = false;
    const stills = recordStills();
    const local = URL.createObjectURL(new Blob([GIF], { type: 'image/gif' }));
    const source =
      kind === 'local'
        ? local
        : kind === 'encrypted'
          ? JSON.stringify({ url: 'mxc://example.org/browser-encrypted-avatar' })
          : `mxc://example.org/browser-${kind}-avatar${kind === 'named-gif' ? '.gif' : ''}`;
    try {
      const screen = await render(Avatar, {
        src: source,
        name: 'Sable',
        original: kind === 'original',
      });
      const root = screen.container.querySelector<HTMLElement>('.avatar-root');
      if (!root) throw new Error('avatar not rendered');
      await userEvent.unhover(root);
      const thumbnail = () => root.querySelector<HTMLImageElement>('img');
      await vi.waitFor(() => {
        expect(stills.has(thumbnail()?.getAttribute('src') ?? '')).toBe(true);
        expect(thumbnail()?.naturalWidth).toBe(1);
      });
      expect(root.querySelectorAll('img')).toHaveLength(1);

      await page.elementLocator(root).hover();
      await vi.waitFor(() => {
        const images = root.querySelectorAll('img');
        const animated = images[images.length - 1];
        expect(animated.getAttribute('src')).toMatch(/^blob:/);
        expect(animated.complete).toBe(true);
        expect(animated.naturalWidth).toBe(1);
        expect(animated.closest<HTMLElement>('.avatar-image')?.style.opacity).toBe('');
        if (images.length > 1) {
          expect(images[0].closest<HTMLElement>('.avatar-image')?.style.opacity).toBe('0');
        }
      });

      await userEvent.unhover(root);
      await vi.waitFor(() => {
        expect(root.querySelectorAll('img')).toHaveLength(1);
        expect(stills.has(thumbnail()?.getAttribute('src') ?? '')).toBe(true);
      });
    } finally {
      URL.revokeObjectURL(local);
    }
  }
);
