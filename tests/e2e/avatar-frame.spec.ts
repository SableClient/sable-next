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
