import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

async function layers(page: import('@playwright/test').Page, selector: string) {
  return page.locator(selector).evaluate((root) => {
    const frame = root.getBoundingClientRect();
    return [...root.querySelectorAll('.media-image')].map((layer) => {
      const box = layer.getBoundingClientRect();
      return [
        box.left - frame.left,
        box.top - frame.top,
        box.width - frame.width,
        box.height - frame.height,
      ].map(Math.round);
    });
  });
}

test('an avatar picture fills its frame exactly, however wide the image', async ({
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      avatar_url: 'mxc://example.test/wide-avatar',
    };
  });
  await installRoomCore('ready');
  await page.goto('/settings/account');
  const avatar = page.locator('.avatar-root:has(img)').first();
  await expect(avatar.locator('img').first()).toBeVisible({ timeout: 30_000 });

  expect(await layers(page, '.avatar-root:has(img) >> nth=0')).toEqual([[0, 0, 0, 0]]);
});

test('the hover animation stacks over the still picture inside the frame', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await timeline.expectRevealed();
  const subscription = await core.subscription();
  await core.setTimelineItemById(subscription, 'general-19', {
    ...timelineItem('general-19', 'Hover me'),
    sender: '@hover:example.test',
    sender_name: 'Hover',
    sender_avatar: 'mxc://example.test/wide-avatar',
  });
  const row = page.locator('[data-item-id="general-19"]');
  const frame = row.locator('.avatar-root').first();
  await expect(frame.locator('img').first()).toBeVisible({ timeout: 30_000 });
  const width = await frame.evaluate((node) => node.getBoundingClientRect().width);

  await row.hover();
  await expect(frame.locator('.media-image')).toHaveCount(2);

  expect(await frame.evaluate((node) => node.getBoundingClientRect().width)).toBe(width);
  expect(await layers(page, '[data-item-id="general-19"] .avatar-root >> nth=0')).toEqual([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile profile avatar' : 'desktop profile avatar', () => {
    test.use({
      hasTouch: mobile,
      viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 800 },
    });

    for (const hero of [null, '#430039']) {
      for (const scheme of ['light', 'dark'] as const) {
        test(`transparent avatars cover the banner (${scheme}, ${hero ? 'tinted' : 'default'})`, async ({
          app,
          page,
          installRoomCore,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.addInitScript((heroColor) => {
            (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
              avatar_url: 'mxc://example.test/transparent-avatar',
              banner_url: 'mxc://example.test/banner',
              hero_color: heroColor,
            };
            window.__e2eFetchMedia = async (source) => {
              const canvas = new OffscreenCanvas(96, 96);
              const context = canvas.getContext('2d');
              if (!context) throw new Error('No canvas context');
              const transparent = source.endsWith('/transparent-avatar');
              context.fillStyle = transparent ? '#ffffff' : '#ff0000';
              if (transparent) context.fillRect(32, 32, 32, 32);
              else context.fillRect(0, 0, 96, 96);
              const blob = await canvas.convertToBlob({ type: 'image/png' });
              return new Uint8Array(await blob.arrayBuffer());
            };
          }, hero);
          await installRoomCore('ready');
          await app.openRoom('!room:example.test');
          await page.getByRole('button', { name: "Open Alice's profile" }).last().click();

          const card = page.locator('.profile-card');
          const avatar = card.locator('.profile-card-avatar');
          const cover = card.locator('.profile-card-cover');
          await expect(avatar.locator('img')).toBeVisible();
          await expect(cover.locator('img')).toBeVisible();
          await expect
            .poll(() =>
              cover
                .locator('img')
                .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
            )
            .toBe(true);
          await expect(avatar.locator('.media-image')).not.toHaveAttribute('style', /background/);

          const box = await avatar.boundingBox();
          if (!box) throw new Error('Avatar is not laid out');
          const clip = {
            x: box.x + box.width / 4,
            y: box.y + box.height / 8,
            width: box.width / 2,
            height: (box.height * 3) / 4,
          };
          const withBanner = await page.screenshot({ clip });
          await cover.evaluate((element) => (element.style.visibility = 'hidden'));
          expect((await page.screenshot({ clip })).equals(withBanner)).toBe(true);
        });
      }
    }
  });
}
