import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/config/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/config/runtime-config.js')>()),
  runtimeConfig: () => Promise.resolve({ exploreServers: [] }),
}));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import Explore from './+page.svelte';

test.each([390, 1280])(
  'Explore scrolls at the page edge with centered content at %spx',
  async (width) => {
    await page.viewport(width, 800);
    const screen = await render(Explore);
    const main = screen.getByRole('main').element() as HTMLElement;
    main.style.height = '400px';
    const filler = document.createElement('div');
    filler.style.height = '1200px';
    main.append(filler);

    expect(main.getBoundingClientRect().width).toBeCloseTo(width, 0);
    expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
    const heading = screen
      .getByRole('heading', { level: 1 })
      .element()
      .closest('header') as HTMLElement;
    const header = heading.getBoundingClientRect();
    expect(header.left).toBeCloseTo(main.clientWidth - header.right, 0);
    expect(document.documentElement.scrollWidth).toBe(width);
  }
);
