import { afterEach, expect, test, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { core } from '#lib/core/__mocks__/context.js';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import ProfileCard from './ProfileCard.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateColorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  }
}

async function png(transparent: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(96, 96);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = transparent ? '#ffffff' : '#ff0000';
  if (transparent) context.fillRect(32, 32, 32, 32);
  else context.fillRect(0, 0, 96, 96);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

afterEach(async () => {
  await commands.emulateColorScheme('light');
});

for (const heroColor of [null, '#430039']) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`transparent avatars cover the banner (${scheme}, ${heroColor ? 'tinted' : 'default'})`, async () => {
      await commands.emulateColorScheme(scheme);
      Object.assign(core, {
        session: { user_id: '@alice:example.test' },
        fetchMedia: vi.fn(async (source: string) => png(source.endsWith('/transparent-avatar'))),
      });

      const screen = await render(ProfileCard, {
        displayName: 'Alice',
        userId: '@alice:example.test',
        color: '#abcdef',
        heroColor,
        avatarUrl: 'mxc://example.test/transparent-avatar',
        bannerUrl: 'mxc://example.test/banner',
      });

      const avatar = screen.container.querySelector<HTMLElement>('.profile-card-avatar');
      const cover = screen.container.querySelector<HTMLElement>('.profile-card-cover');
      if (!avatar || !cover) throw new Error('The profile card is not rendered');
      await vi.waitFor(() => {
        const image = cover.querySelector('img');
        expect(image?.complete && image.naturalWidth > 0).toBe(true);
        expect(avatar.querySelector('img')).not.toBeNull();
      });
      expect(avatar.querySelector('.media-image')?.getAttribute('style') ?? '').not.toMatch(
        /background/
      );

      const withBanner = await page
        .elementLocator(avatar)
        .screenshot({ save: false, base64: true });
      cover.style.visibility = 'hidden';
      const withoutBanner = await page
        .elementLocator(avatar)
        .screenshot({ save: false, base64: true });
      expect(withoutBanner).toBe(withBanner);
    });
  }
}
