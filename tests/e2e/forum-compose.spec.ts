import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('forum');
  await page.goto('/rooms/!room%3Aexample.test');
  await expect(page.getByRole('button', { name: en.forum.newThread })).toBeVisible({
    timeout: 45_000,
  });
});

test('a new thread is composed on demand and sent with its title', async ({ page }) => {
  const main = page.locator('.forum-main');
  const editor = main.locator('[contenteditable="true"]');
  const title = main.getByRole('textbox', { name: en.forum.titleLabel });
  await expect(editor).toHaveCount(0);

  await main.getByRole('button', { name: en.forum.newThread }).click();
  await expect(title).toBeFocused();
  await title.fill('Release plans');
  await editor.first().fill('Shall we ship on the 12th?');
  await main.getByRole('button', { name: en.timeline.sendMessage, exact: true }).click();

  await expect
    .poll(() => page.evaluate(() => window.__e2eCalls))
    .toContainEqual({
      method: 'messages.send',
      params: expect.objectContaining({
        body: 'Shall we ship on the 12th?',
        forum_title: 'Release plans',
        thread_root: null,
      }),
    });
  await expect(editor).toHaveCount(0);

  await main.getByRole('button', { name: en.forum.newThread }).click();
  await expect(title).toHaveValue('');
  await expect(editor.first()).toBeEmpty();
});

test('editing a thread opens the composer with its title and body', async ({ page, core }) => {
  const main = page.locator('.forum-main');
  const root = {
    ...timelineItem('root', 'Original body'),
    forum_title: 'Original title',
    is_own: true,
  };
  await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values: [root] }]);
  const card = main.getByRole('article');
  await expect(card).toContainText('Original title');

  await card.hover();
  await card.getByRole('button', { name: en.timeline.moreActions }).click();
  await page.getByRole('menuitem', { name: en.timeline.editMessage }).click();

  const title = main.getByRole('textbox', { name: en.forum.titleLabel });
  const editor = main.locator('[contenteditable="true"]').first();
  await expect(title).toHaveValue('Original title');
  await expect(editor).toHaveText('Original body');

  await title.fill('Better title');
  await editor.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.__e2eCalls))
    .toContainEqual({
      method: 'messages.edit',
      params: expect.objectContaining({ forum_title: 'Better title' }),
    });
  await expect(main.locator('[contenteditable="true"]')).toHaveCount(0);
});

test('the search bar filters threads and starts one from what was typed', async ({
  page,
  core,
}) => {
  const main = page.locator('.forum-main');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'reset',
      values: [
        { ...timelineItem('a', 'About the release'), forum_title: 'Release plans' },
        { ...timelineItem('b', 'The sidebar flickers') },
      ],
    },
  ]);
  const threads = main.getByRole('list', { name: en.forum.threads });
  await expect(threads.getByRole('listitem')).toHaveCount(2);

  const search = main.getByRole('searchbox');
  await search.fill('flick');
  await expect(threads.getByRole('listitem')).toHaveCount(1);
  await expect(threads).toContainText('The sidebar flickers');

  await search.press('Enter');
  await expect(search).toHaveValue('flick');
  await expect(main.locator('[contenteditable="true"]')).toHaveCount(0);

  await search.fill('Holiday rota');
  await expect(main.locator('.forum-thread-list-empty')).toBeVisible();
  await search.press('Enter');
  await expect(main.getByRole('textbox', { name: en.forum.titleLabel })).toHaveValue(
    'Holiday rota'
  );
  await expect(threads).toContainText('Release plans');
  await expect(threads).toContainText('The sidebar flickers');
});

test('the gallery view is remembered', async ({ page }) => {
  const main = page.locator('.forum-main');
  await main.getByRole('button', { name: en.forum.viewGallery }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('sable-forum-layout')))
    .toBe('gallery');

  await page.reload();
  await expect(main.getByRole('button', { name: en.forum.viewList })).toBeVisible();
});
