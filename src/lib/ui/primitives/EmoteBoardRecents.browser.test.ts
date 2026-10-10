import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.hoisted(() => {
  localStorage.setItem(
    'sable-recent-reactions',
    JSON.stringify([
      { emoji: 'mxc://example.test/partyparrot', total: 3 },
      { emoji: 'this is a long text reaction', total: 2 },
      { emoji: '🔥', total: 1 },
    ])
  );
});

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/emoji/load-packs.js', () => ({
  isPackChange: () => false,
  loadPacks: (
    _commands: unknown,
    _roomId: string,
    apply: (loaded: unknown[]) => void
  ): Promise<boolean> => {
    apply([]);
    return Promise.resolve(true);
  },
}));

import { core } from '#lib/core/__mocks__/context.js';

import EmoteBoard from './EmoteBoard.svelte';

async function mountBoard() {
  await page.viewport(1280, 900);
  Object.assign(core, { fetchMedia: vi.fn().mockResolvedValue(new Uint8Array()) });
  const screen = await render(EmoteBoard, {
    roomId: '!room:example.test',
    unicode: true,
    onPick: vi.fn(),
  });
  await expect.poll(() => document.querySelector('.virtual-list-wrapper')).not.toBeNull();
  return screen;
}

test('unicode emoji in the board are not clipped', async () => {
  await mountBoard();
  const glyph = document.querySelector<HTMLElement>('.unicode-text');
  if (!glyph) throw new Error('no unicode glyph is rendered');

  expect(glyph.scrollHeight).toBeLessThanOrEqual(glyph.clientHeight);
});

test('frequently used keeps custom emotes and text reactions inside their cells', async () => {
  const screen = await mountBoard();
  const recents = () => [
    ...document.querySelectorAll<HTMLElement>('[data-section="recent"] [role="gridcell"]'),
  ];
  await expect.poll(() => recents().length).toBeGreaterThan(0);

  expect(recents()[0]?.querySelector('.unicode-text')?.textContent).toBe(
    'this is a long text reaction'
  );
  expect(recents().filter((cell) => cell.scrollWidth > cell.clientWidth + 1)).toHaveLength(0);

  await screen
    .getByRole('navigation', { name: 'Packs' })
    .getByRole('button', { name: 'Smileys and people' })
    .click();
  await expect
    .poll(() => document.querySelector('[data-section="people"] .unicode-text'))
    .not.toBeNull();
  const clipped = [
    ...document.querySelectorAll<HTMLElement>('[data-section="people"] .unicode-text'),
  ].filter((glyph) => glyph.scrollWidth > glyph.clientWidth + 1);
  expect(clipped).toHaveLength(0);
});
