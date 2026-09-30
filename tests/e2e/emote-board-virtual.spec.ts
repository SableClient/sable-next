import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { ImagePackView } from '#src/generated/protocol';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

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

test.beforeEach(async ({ page, app, installRoomCore }) => {
  await page.addInitScript((imagePacks) => {
    (window as unknown as { __e2eImagePacks: ImagePackView[] }).__e2eImagePacks = imagePacks;
  }, packs);
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: 'Emotes and stickers' }).click();
});

test('search lists matches from the top and stays inside the board', async ({ page }) => {
  const list = page.locator('.virtual-list-wrapper');
  await expect(list).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 2000;
  });

  await page.getByRole('searchbox').fill('beta7');
  await expect(page.getByRole('button', { name: ':beta7:', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: ':beta70:' })).toBeVisible();
  await expect(page.getByRole('button', { name: ':alpha7:' })).toHaveCount(0);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

  const box = await page.locator('.grids').boundingBox();
  const listBox = await list.boundingBox();
  if (!box || !listBox) throw new Error('board has no box');
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(box.y + box.height + 1);
});

test('a pack jump lands on its header and repeats after scrolling away', async ({ page }) => {
  const list = page.locator('.virtual-list-wrapper');
  const rail = page.getByRole('navigation', { name: 'Packs' });
  const jump = rail.getByRole('button', { name: /gamma/ });
  const header = list.getByRole('heading', { name: /gamma/ });

  await jump.click();
  await expect(header).toBeVisible();
  const landed = await list.evaluate((element) => element.scrollTop);

  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await jump.click();
  await expect(header).toBeVisible();
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeCloseTo(landed, -1);
});

test.describe('pack navigation with motion enabled', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  for (const target of ['gamma', 'pack-20']) {
    test(`sidebar jump to ${target} loads stickers without starving timeline images`, async ({
      page,
      core,
      timeline,
    }) => {
      await page.getByRole('button', { name: 'Stickers', exact: true }).click();
      const first = page.locator('.grids img').first();
      await expect(first).toBeVisible();
      await expect
        .poll(() => first.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      const skipped = packIds.slice(1, packIds.indexOf(target));
      await page.evaluate(async (skipped) => {
        const image = document.querySelector<HTMLImageElement>('.grids img');
        if (!image) throw new Error('first sticker is missing');
        const response = await fetch(image.src);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let active = 0;
        const waiting: (() => void)[] = [];
        window.__e2eFetchMedia = async (source, width) => {
          // Rail icons do not compete with downloads from the sticker grid.
          if (width === 48) return bytes;
          const skippedPack = skipped.some((id) => source.startsWith(`mxc://example.test/${id}`));
          if (skippedPack) window.__e2eCommands.push(`skipped_sticker ${source}`);
          if (active === 6) await new Promise<void>((resolve) => waiting.push(resolve));
          else active += 1;
          try {
            await new Promise((resolve) => window.setTimeout(resolve, skippedPack ? 5_000 : 20));
            return bytes;
          } finally {
            const next = waiting.shift();
            if (next) next();
            else active -= 1;
          }
        };
      }, skipped);
      await page
        .getByRole('navigation', { name: 'Packs' })
        .getByRole('button', { name: target, exact: true })
        .click();
      await core.setTimelineItemById(await core.subscription(), 'general-19', {
        ...timelineItem('general-19', 'Timeline image'),
        content: {
          kind: 'image',
          filename: 'Timeline image',
          caption: null,
          html: null,
          source: 'mxc://example.test/outside-picker',
          mime: 'image/png',
          width: 80,
          height: 60,
          size: null,
          blurhash: null,
          spoiler: null,
        },
      });
      const destination = page.getByRole('button', { name: `:${target}0:`, exact: true });
      await expect(destination).toBeVisible();
      await expect
        .poll(
          () => destination.evaluate((button) => button.querySelector('img')?.naturalWidth ?? 0),
          {
            timeout: 1_000,
          }
        )
        .toBeGreaterThan(0);
      await expect
        .poll(
          () =>
            timeline.container.evaluate(
              (element) =>
                element.querySelector<HTMLImageElement>('img[alt="Timeline image"]')
                  ?.naturalWidth ?? 0
            ),
          { timeout: 1_000 }
        )
        .toBeGreaterThan(0);
      // A few neighboring rows remain mounted as the virtual list's scroll buffer.
      const skippedRequests = (await core.commands()).filter((command) =>
        command.startsWith('skipped_sticker')
      );
      expect(skippedRequests.length).toBeLessThanOrEqual(16);
    });
  }
});

test('arrow keys move focus through unicode rows that are not mounted yet', async ({ page }) => {
  const list = page.locator('.virtual-list-wrapper');
  await page
    .getByRole('navigation', { name: 'Packs' })
    .getByRole('button', { name: 'Smileys and people' })
    .click();
  const people = page.locator('[data-section="people"]');
  await expect(people.locator('[data-cell="0"]')).toBeVisible();

  await people.locator('[data-cell="0"]').focus();
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-section="people"] [data-cell]:focus')).toHaveCount(1);
  const focused = await page
    .locator('[data-section="people"] [data-cell]:focus')
    .getAttribute('data-cell');
  expect(Number(focused)).toBeGreaterThanOrEqual(40 * 6);
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('unicode search results replace the groups', async ({ page }) => {
  await page.getByRole('searchbox').fill('fire');
  await expect(page.getByRole('button', { name: /fire/i }).first()).toBeVisible();
  await expect(page.locator('[data-section="people"]')).toHaveCount(0);
  await expect(page.locator('[data-section="search"] [data-cell]').first()).toBeVisible();
});

test('sticker rows keep every cell whole on one line', async ({ page }) => {
  await page.getByRole('button', { name: 'Stickers', exact: true }).click();
  await expect(page.getByRole('button', { name: ':alpha0:', exact: true })).toBeVisible();

  const rows = await page.locator('.grids ul').evaluateAll((lists) =>
    lists.map((list) =>
      [...list.children].map((cell) => {
        const box = cell.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      })
    )
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
