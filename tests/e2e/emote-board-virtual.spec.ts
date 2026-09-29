import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { ImagePackView } from '#src/generated/protocol';

test.use({ storageState: SIGNED_OUT });

const packs: ImagePackView[] = ['alpha', 'beta', 'gamma'].map((id) => ({
  id,
  origin: 'room',
  room_id: '!room:example.test',
  name: id,
  avatar_url: null,
  attribution: null,
  usage: ['emoticon', 'sticker'],
  images: Array.from({ length: 80 }, (_, index) => ({
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
