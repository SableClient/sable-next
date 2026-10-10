import { afterEach, expect, test, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { ProfileView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], byId: () => undefined }),
  roomPathParamFromId: (roomId: string) => roomId,
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';

import MentionProfileCard from './MentionProfileCard.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateColorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  }
}

afterEach(async () => {
  await commands.emulateColorScheme('light');
});

const baseProfile: ProfileView = {
  user_id: '@alice:example.test',
  display_name: 'Alice',
  avatar_url: null,
  bio: 'Hello <a href="https://example.org">link</a> <code>code</code>',
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [{ summary: 'they/them', language: 'en' }],
  timezone: 'Europe/Paris',
  name_color_light: null,
  name_color_dark: null,
  animal: null,
  extra: [{ key: 'io.example.thing', value: 'x' }],
  supporter_awards: null,
  legacy_fields: [],
};

function mountCard(patch: Partial<ProfileView>) {
  Object.assign(core, {
    session: { user_id: '@me:example.test' },
    userRelations: vi.fn().mockResolvedValue({ mutualRooms: [], ignored: false }),
    roomMembers: vi.fn().mockResolvedValue([]),
  });
  return render(MentionProfileCard, {
    userId: baseProfile.user_id,
    roomId: '!room:example.test',
    member: null,
    profile: { ...baseProfile, ...patch },
  });
}

function relativeLuminance(probe: CanvasRenderingContext2D, color: string): number {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = [...probe.getImageData(0, 0, 1, 1).data].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function backgroundOf(element: Element | null): string {
  for (let node = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
  }
  return 'white';
}

function illegibleText(root: Element): string[] {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe) throw new Error('no canvas');
  const failures: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    const text = node.textContent?.trim();
    if (!element || !text || element.closest('.avatar-root, input')) continue;
    const fg = relativeLuminance(probe, getComputedStyle(element).color);
    const bg = relativeLuminance(probe, backgroundOf(element));
    const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (contrast < 4.5) failures.push(`${text} (${contrast.toFixed(2)})`);
  }
  return failures;
}

const CASES = [
  { scheme: 'light', hero: '#1b1b3a', brightness: 'dark' },
  { scheme: 'dark', hero: '#f4e7c8', brightness: 'light' },
  { scheme: 'light', hero: '#ff0000', brightness: 'dark' },
  { scheme: 'dark', hero: '#ff0000', brightness: 'light' },
  { scheme: 'light', hero: '#ff0000', brightness: null },
] as const;

for (const { scheme, hero, brightness } of CASES) {
  test(`a ${hero} profile card with ${brightness ?? 'automatic'} brightness keeps its text legible on the ${scheme} theme`, async () => {
    await commands.emulateColorScheme(scheme);
    const screen = await mountCard({ hero_color: hero, hero_brightness: brightness });
    const card = document.querySelector('.profile-card');
    if (!card) throw new Error('the profile card is not rendered');
    await expect.element(screen.getByText('Show misc. data', { exact: false })).toBeVisible();

    expect(illegibleText(card)).toEqual([]);
  });
}

test('an open action on a tinted card keeps its icon in the card ink', async () => {
  await commands.emulateColorScheme('light');
  await mountCard({ hero_color: '#7a2e0e', hero_brightness: 'dark' });
  const share = document.querySelector<HTMLElement>('.profile-card .pill[aria-haspopup]');
  if (!share) throw new Error('the share action is not rendered');
  await userEvent.click(share);
  await expect.poll(() => share.getAttribute('aria-expanded')).toBe('true');

  const icon = share.querySelector('svg');
  const card = share.closest('.profile-card');
  if (!icon || !card) throw new Error('the action has no icon or card');
  const text = getComputedStyle(share).color;
  expect(getComputedStyle(icon).color).toBe(text);
  expect(text).toBe(getComputedStyle(card).color);
});
