import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  await page.route('https://example.test/_matrix/client/versions', (route) =>
    route.fulfill({ json: {} })
  );
});

test('a link to a thread reply opens and highlights it in the thread', async ({
  app,
  page,
  core,
  installRoomCore,
}) => {
  await installRoomCore('thread_links');
  await app.openRoom('!room:example.test');
  const link = 'https://matrix.to/#/!room:example.test/$thread-reply-10:example.test';
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: [
        {
          ...timelineItem('link', link),
          content: {
            kind: 'message',
            body: link,
            html: `<a href="${link}">Linked thread reply</a>`,
            emote: false,
            notice: false,
            edited: false,
          },
        },
      ],
    },
  ]);
  await page.getByRole('link', { name: 'Linked thread reply' }).click();

  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible();
  await expect(thread.locator('[data-event-id="$thread-reply-10:example.test"]')).toBeInViewport();
  await expect(thread.locator('.highlighted')).toContainText('Thread reply 10');
  expect(await page.evaluate(() => window.__e2eTimelineFocus)).not.toContainEqual({
    kind: 'event',
    event_id: '$thread-reply-10:example.test',
  });
  await thread.getByRole('button', { name: en.timeline.backToConversation, exact: true }).click();
  await expect(thread).toBeHidden();
  await expect(page.locator('.room-view > .timeline')).toBeVisible();
});

test('a direct link loads an older reply from thread history', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('thread_links');
  await page.goto('/rooms/!room%3Aexample.test?event=%24thread-reply-older%3Aexample.test');

  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible();
  await expect(
    thread.locator('[data-event-id="$thread-reply-older:example.test"]')
  ).toBeInViewport();
  await expect(thread.locator('.highlighted')).toContainText('Older thread reply');
  expect(await page.evaluate(() => window.__e2eTimelineFocus)).not.toContainEqual({
    kind: 'event',
    event_id: '$thread-reply-older:example.test',
  });
});

test('an external thread reply link opens the thread', async ({ app, page, installRoomCore }) => {
  await installRoomCore('thread_links');
  await app.openMatrixToLink('!room:example.test', '$thread-reply-10:example.test');
  await expect(page).toHaveURL(/\?event=/, { timeout: COLD_BOOT_TIMEOUT });

  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible();
  await expect(thread.locator('.highlighted')).toContainText('Thread reply 10');
});

test('an ordinary message link stays in the room timeline', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('thread_links');
  await app.openPermalink('!room:example.test', '$general-8:example.test');

  await expect(page.locator('.room-view > .timeline .highlighted')).toBeInViewport();
  await expect(page.getByRole('region', { name: en.timeline.thread, exact: true })).toHaveCount(0);
});
