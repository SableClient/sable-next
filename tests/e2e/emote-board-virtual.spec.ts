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

test.beforeEach(async ({ page, app, installRoomCore }) => {
  await page.addInitScript((imagePacks) => {
    (window as unknown as { __e2eImagePacks: ImagePackView[] }).__e2eImagePacks = imagePacks;
  }, packs);
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: 'Emotes and stickers' }).click();
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

test('shift-click inserts an emote and keeps the board open', async ({ page }) => {
  const board = page.locator('.composer-board');
  const inserted = page.locator('.ProseMirror img:not(.ProseMirror-separator)');

  await page.getByRole('button', { name: ':alpha0:', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: ':alpha1:', exact: true }).click({ modifiers: ['Shift'] });
  await expect(inserted).toHaveCount(2);
  await expect(board).toBeVisible();

  await page.getByRole('button', { name: ':alpha2:', exact: true }).click();
  await expect(inserted).toHaveCount(3);
  await expect(board).toBeHidden();
});
