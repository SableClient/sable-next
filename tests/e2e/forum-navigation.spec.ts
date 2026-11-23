import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, installRoomCore, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('forum');
});

test('a forum post permalink opens its thread and closes back to the forum on desktop and touch', async ({
  page,
}) => {
  await page.goto('/rooms/!room%3Aexample.test?event=%24thread-root%3Aexample.test');
  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  await expect(page.locator('.forum-page')).toBeVisible();
  await expect(page.locator('.room-view')).toHaveCount(0);
  await expect(thread.locator('[data-event-id="$thread-root:example.test"]')).toBeVisible();
  await thread.getByRole('button', { name: en.forum.backToForum, exact: true }).click();
  await expect(thread).toHaveCount(0);
  await expect(page).not.toHaveURL(/event=/);
  await expect(page.getByRole('list', { name: en.forum.threads, exact: true })).toBeVisible();
});

for (const target of ['10', 'older']) {
  test(`a forum reply permalink highlights reply ${target} inside its thread on desktop and touch`, async ({
    page,
  }) => {
    await page.goto(`/rooms/!room%3Aexample.test?event=%24thread-reply-${target}%3Aexample.test`);
    const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
    await expect(thread).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
    await expect(page.locator('.forum-page')).toBeVisible();
    await expect(page.locator('.room-view')).toHaveCount(0);
    await expect(thread.locator('.highlighted')).toContainText(
      target === 'older' ? 'Older thread reply' : 'Thread reply 10'
    );
    await expect(
      thread.locator(`[data-event-id="$thread-reply-${target}:example.test"]`)
    ).toBeInViewport();
  });
}

test('a reaction permalink opens the reacted reply in its thread on desktop and touch', async ({
  page,
}) => {
  await page.goto('/rooms/!room%3Aexample.test?event=%24reaction%3Aexample.test');
  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  await expect(page.locator('.forum-page')).toBeVisible();
  await expect(thread.locator('.highlighted')).toContainText('Thread reply 10');
});

test('an unavailable forum permalink falls back to the event timeline on desktop and touch', async ({
  page,
}) => {
  await page.goto('/rooms/!room%3Aexample.test?event=%24missing%3Aexample.test');
  await expect(page.locator('.room-view > .timeline')).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  await expect(page.locator('.forum-page')).toHaveCount(0);
  await expect(page).toHaveURL(/timeline=events/);
  await expect(page).toHaveURL(/event=%24missing%3Aexample\.test/);
});

test('opening another thread beside a linked thread drops the permalink', async ({
  page,
  core,
  isMobile,
}) => {
  test.skip(isMobile, 'threads cover the forum on touch layouts');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation: 'panel' }));
  });
  await page.goto('/rooms/!room%3Aexample.test?event=%24thread-reply-10%3Aexample.test');
  const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(thread).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  await expect(thread).toHaveClass(/side-panel/);

  const other = { ...timelineItem('other', 'Still open'), forum_title: 'Unfinished feature' };
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [{ op: 'push_back', value: other }]);
  await page
    .locator('.forum-main')
    .getByRole('article')
    .filter({ hasText: 'Unfinished feature' })
    .click();

  await expect(page).not.toHaveURL(/event=/);
  await expect(thread.getByRole('heading', { name: 'Unfinished feature' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: en.forum.newThread })).toBeVisible({
    timeout: COLD_BOOT_TIMEOUT,
  });
  await expect(page.getByRole('region', { name: en.timeline.thread, exact: true })).toHaveCount(0);
});

test('an explicit forum event timeline still opens normally', async ({ page }) => {
  await page.goto('/rooms/!room%3Aexample.test?timeline=events&event=%24general-8%3Aexample.test');
  await expect(page.locator('.room-view > .timeline')).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  await expect(page.locator('.forum-page')).toHaveCount(0);
});

for (const layout of ['list', 'gallery']) {
  test(`a redacted forum post disappears from the ${layout} on desktop and touch`, async ({
    page,
    core,
  }) => {
    await page.goto('/rooms/!room%3Aexample.test');
    await expect(page.getByRole('button', { name: en.forum.newThread })).toBeVisible({
      timeout: COLD_BOOT_TIMEOUT,
    });
    if (layout === 'gallery')
      await page.getByRole('button', { name: en.forum.viewGallery }).click();
    const root = {
      ...timelineItem('root', 'Original body'),
      forum_title: 'Finished feature',
      thread_summary: {
        num_replies: 2,
        latest_event_id: '$reply',
        latest_body: 'Old reply',
        latest_fallback: null,
        latest_emotes: [],
      },
    };
    const other = { ...timelineItem('other', 'Still open'), forum_title: 'Unfinished feature' };
    const subscription = await core.subscription();
    await core.emitTimelineDiff(subscription, [{ op: 'reset', values: [root, other] }]);
    const cards = page.locator('.forum-main').getByRole('article');
    await expect(cards).toHaveCount(2);
    await core.emitTimelineDiff(subscription, [
      {
        op: 'set',
        index: 0,
        value: {
          ...root,
          content: { kind: 'redacted', reason: null, redacted_by: null },
        },
      },
    ]);
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Unfinished feature');
    await expect(page.locator('.forum-main')).not.toContainText('Finished feature');
  });
}
