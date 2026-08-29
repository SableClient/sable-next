import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

const LINK_MESSAGE = {
  kind: 'message',
  body: 'Check this out https://example.test/article',
  html: 'Check this out <a href="https://example.test/article">https://example.test/article</a>',
  emote: false,
  edited: false,
};

test('a message with a link renders a preview when link previews are enabled', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ urlPreviews: true }));
  });
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: { ...timelineItem('link-message-on', 'Check this out'), content: LINK_MESSAGE },
    },
  ]);

  const preview = page.locator('.link-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('href', 'https://example.test/article');
  await expect(preview.locator('.link-preview-title')).toHaveText('The Example Article');
  await expect(preview.locator('.link-preview-site')).toHaveText('Example');
});

test('a message with a link renders nothing when link previews are disabled', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: { ...timelineItem('link-message-off', 'Check this out'), content: LINK_MESSAGE },
    },
  ]);

  await expect(timeline.message('Check this out https://example.test/article')).toBeVisible();
  await expect(page.locator('.link-preview')).toHaveCount(0);
  expect(await core.commands()).not.toContain('url_preview');
});
