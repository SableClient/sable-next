import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { timelineItem as item } from '#lib/features/room/timeline/test-items.js';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], roomSpaces: () => null }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({
    personas: [],
    load: () => Promise.resolve(),
    associationFor: () => undefined,
    selectionFor: () => null,
  }),
}));
vi.mock('../messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

import TimelineListHarness from './TimelineListHarness.test.svelte';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('--primary-container');
});

function surfaceColor(): string {
  const probe = document.createElement('div');
  probe.style.background = 'var(--surface-container)';
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

test.each(['light', 'dark'])(
  'the unread banner hides messages behind it in %s even with a see-through theme colour',
  async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.setProperty('--primary-container', 'rgb(0 0 0 / 0.2)');
    const roomTimeline = new RoomTimeline({} as CoreClient);
    roomTimeline.hasSnapshot = true;
    roomTimeline.items = Array.from({ length: 30 }, (_, index) => item(`recent-${index}`));
    await render(TimelineListHarness, {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$old-marker'),
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    });

    await expect.element(page.getByRole('button', { name: 'Jump to unread' })).toBeVisible();
    const banner = document.querySelector('.unread-float');
    if (!(banner instanceof HTMLElement)) throw new Error('unread banner not found');
    expect(getComputedStyle(banner).backgroundColor).toBe(surfaceColor());
  }
);
