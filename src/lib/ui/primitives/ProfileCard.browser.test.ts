import { afterEach, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { core } from '#lib/core/__mocks__/context.js';

import en from '../../../locales/en.json' with { type: 'json' };

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

const LONG_STATUS = 'A long status that needs scrolling to read in full. '.repeat(30);

function statusCard() {
  return render(ProfileCard, {
    displayName: 'Alice',
    userId: '@alice:example.test',
    color: '#abcdef',
    status: LONG_STATUS,
    statusEmoji: '💭',
  });
}

function overflowY(element: Element): string {
  return getComputedStyle(element).overflowY;
}

function box(selector: string): DOMRect {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`${selector} is not rendered`);
  return node.getBoundingClientRect();
}

test('keyboard focus reveals the status and lets the reader scroll it', async () => {
  const screen = await statusCard();
  const status = screen.getByRole('region', { name: en.settings.status });
  const node = () => status.element();
  document.querySelector<HTMLElement>('.profile-card-user-id')?.focus();
  await userEvent.unhover(node());
  expect(overflowY(node())).toBe('hidden');

  node().focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await userEvent.keyboard('{Tab}');
  await expect.element(status).toHaveFocus();
  expect(overflowY(node())).toBe('auto');
  await userEvent.keyboard('{ArrowDown}');
  await expect.poll(() => node().scrollTop).toBeGreaterThan(0);
  await userEvent.keyboard(' ');
  await expect.poll(() => node().scrollTop).toBeGreaterThan(30);

  const bubble = document.querySelector<HTMLElement>('.profile-card-status');
  if (!bubble) throw new Error('the status bubble is not rendered');
  await userEvent.hover(bubble);
  await userEvent.unhover(bubble);
  expect(overflowY(node())).toBe('auto');
  await userEvent.keyboard('{Tab}');
  expect(overflowY(node())).toBe('hidden');
  await expect.poll(() => node().scrollTop).toBe(0);
});

test('a hovered status clears the name and the actions below it', async () => {
  const screen = await statusCard();
  const status = screen.getByRole('region', { name: en.settings.status });
  document.querySelector<HTMLElement>('.profile-card-user-id')?.focus();
  const bubble = document.querySelector<HTMLElement>('.profile-card-status');
  if (!bubble) throw new Error('the status bubble is not rendered');
  await userEvent.hover(bubble);

  expect(overflowY(status.element())).toBe('auto');
  const bubbleBox = box('.profile-card-status');
  const identity = box('.profile-card-identity');
  expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(identity.y);
});

test('an expanded status stays inside the card and above its controls', async () => {
  const screen = await statusCard();
  const status = screen.getByRole('region', { name: en.settings.status });
  status.element().focus();

  expect(overflowY(status.element())).toBe('auto');
  const card = box('.profile-card');
  const bubble = box('.profile-card-status');
  const identity = box('.profile-card-identity');
  expect(bubble.x).toBeGreaterThanOrEqual(card.x);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(card.x + card.width);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(identity.y);
  await userEvent.keyboard('{End}');
  await expect.poll(() => status.element().scrollTop).toBeGreaterThan(0);
});
