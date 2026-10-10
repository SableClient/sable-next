import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { ImagePackView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

const packIds = [
  'alpha',
  'beta',
  'gamma',
  ...Array.from({ length: 29 }, (_, index) => `pack-${String(index + 3)}`),
];

const packs: ImagePackView[] = packIds.map((id, packIndex) => ({
  id,
  origin: 'room',
  room_id: '!room:example.test',
  name: id,
  avatar_url: null,
  declared_name: null,
  declared_avatar_url: null,
  stable_event: false,
  legacy_event: false,
  attribution: null,
  usage: ['emoticon', 'sticker'],
  images: Array.from({ length: packIndex === 31 ? 60 : 80 }, (_, index) => ({
    shortcode: `${id}${String(index)}`,
    url: `mxc://example.test/${id}${String(index)}`,
    body: null,
    usage: ['emoticon', 'sticker'],
    info: null,
    source_pack: null,
  })),
}));

let activePacks: ImagePackView[] = packs;

vi.mock('#lib/emoji/load-packs.js', () => ({
  isPackChange: () => false,
  loadPacks: (
    _commands: unknown,
    _roomId: string,
    apply: (loaded: ImagePackView[]) => void
  ): Promise<boolean> => {
    apply(activePacks);
    return Promise.resolve(true);
  },
}));

import { core } from '#lib/core/__mocks__/context.js';

import EmoteBoard from './EmoteBoard.svelte';

afterEach(async () => {
  activePacks = packs;
  await page.viewport(414, 800);
});

async function mountBoard(props: { tab?: 'emoticon' | 'sticker'; unicode?: boolean } = {}) {
  await page.viewport(1280, 900);
  Object.assign(core, { fetchMedia: vi.fn().mockResolvedValue(new Uint8Array()) });
  const screen = await render(EmoteBoard, {
    roomId: '!room:example.test',
    unicode: true,
    onPick: vi.fn(),
    ...props,
  });
  const list = () => {
    const node = document.querySelector<HTMLElement>('.virtual-list-wrapper');
    if (!node) throw new Error('the board list is not rendered');
    return node;
  };
  await expect.poll(() => document.querySelector('.virtual-list-wrapper')).not.toBeNull();
  return { screen, list };
}

test('search lists matches from the top and stays inside the board', async () => {
  const { screen, list } = await mountBoard();
  list().scrollTop = 2000;

  await userEvent.fill(screen.getByRole('searchbox').element(), 'beta7');
  await expect.element(screen.getByRole('button', { name: ':beta7:', exact: true })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: ':beta70:' })).toBeVisible();
  expect(screen.getByRole('button', { name: ':alpha7:' }).elements()).toHaveLength(0);
  expect(list().scrollTop).toBe(0);

  const grids = document.querySelector('.grids')?.getBoundingClientRect();
  const listBox = list().getBoundingClientRect();
  if (!grids) throw new Error('the board has no grids');
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(grids.y + grids.height + 1);
});

test('a pack jump lands on its header and repeats after scrolling away', async () => {
  const { screen, list } = await mountBoard();
  const jump = screen.getByRole('navigation', { name: 'Packs' }).getByRole('button', {
    name: /gamma/,
  });
  const header = screen.getByRole('heading', { name: /gamma/ });

  await userEvent.click(jump);
  await expect.element(header).toBeVisible();
  const landed = list().scrollTop;

  list().scrollTop = 0;
  await userEvent.click(jump);
  await expect.element(header).toBeVisible();
  await expect.poll(() => Math.abs(list().scrollTop - landed)).toBeLessThan(5);
});

test('arrow keys move focus through unicode rows that are not mounted yet', async () => {
  const { screen, list } = await mountBoard();
  await userEvent.click(
    screen.getByRole('navigation', { name: 'Packs' }).getByRole('button', {
      name: 'Smileys and people',
    })
  );
  const cell = () => document.querySelector<HTMLElement>('[data-section="people"] [data-cell="0"]');
  await expect.poll(cell).not.toBeNull();

  cell()?.focus();
  await userEvent.keyboard('{ArrowDown}'.repeat(40));
  await expect
    .poll(() => document.querySelectorAll('[data-section="people"] [data-cell]:focus').length)
    .toBe(1);
  const focused = document
    .querySelector('[data-section="people"] [data-cell]:focus')
    ?.getAttribute('data-cell');
  expect(Number(focused)).toBeGreaterThanOrEqual(40 * 6);
  expect(list().scrollTop).toBeGreaterThan(0);
});

test('unicode search results replace the groups', async () => {
  const { screen } = await mountBoard();
  await userEvent.fill(screen.getByRole('searchbox').element(), 'fire');

  await expect.element(screen.getByRole('gridcell', { name: /fire/i }).first()).toBeVisible();
  expect(document.querySelector('[data-section="people"]')).toBeNull();
  expect(document.querySelector('[data-section="search"] [data-cell]')).not.toBeNull();
});

test('sticker rows keep every cell whole on one line', async () => {
  const { screen } = await mountBoard({ tab: 'sticker' });
  await expect.element(screen.getByRole('button', { name: ':alpha0:', exact: true })).toBeVisible();

  const rows = [...document.querySelectorAll('.grids ul')].map((list) =>
    [...list.children].map((cell) => {
      const box = cell.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    })
  );
  expect(rows.length).toBeGreaterThan(1);
  for (const [index, cells] of rows.entries()) {
    expect(new Set(cells.map((cell) => cell.top)).size, `row ${String(index)}`).toBe(1);
  }
  for (let index = 1; index < rows.length; index += 1) {
    const bottom = Math.max(...(rows[index - 1] ?? []).map((cell) => cell.bottom));
    const top = Math.min(...(rows[index] ?? []).map((cell) => cell.top));
    expect(bottom, `row ${String(index)}`).toBeLessThanOrEqual(top);
  }
});

test('search shows matching emotes from different packs with the same shortcode', async () => {
  activePacks = ['one', 'two'].map((id) => ({
    id,
    origin: 'room',
    room_id: '!room:example.test',
    name: id,
    avatar_url: null,
    declared_name: null,
    declared_avatar_url: null,
    stable_event: false,
    legacy_event: false,
    attribution: null,
    usage: ['emoticon'],
    images: [
      {
        shortcode: 'duplicate',
        url: `mxc://example.test/${id}`,
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  }));
  const { screen } = await mountBoard();
  await userEvent.fill(screen.getByRole('searchbox').element(), 'duplicate');

  await expect
    .poll(() => screen.getByRole('button', { name: ':duplicate:' }).elements().length)
    .toBe(2);
});
