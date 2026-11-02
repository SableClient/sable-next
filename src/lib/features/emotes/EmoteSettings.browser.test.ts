import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ labelFor: () => 'Emoji room' }),
}));

import EmoteSettings from './EmoteSettings.svelte';

test('the page does not scroll by itself inside settings, so the pack save bar can stick', async () => {
  const scroll = document.createElement('div');
  scroll.className = 'settings-scroll';
  document.body.append(scroll);
  await render(EmoteSettings, { target: scroll });

  await expect.poll(() => scroll.querySelector('.app-page-shell')).not.toBeNull();
  const page = scroll.querySelector<HTMLElement>('.app-page-shell');
  if (!page) throw new Error('Missing page shell');
  expect(getComputedStyle(page).overflowY).toBe('visible');
});
