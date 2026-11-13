import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1400, height: 900 } });

test('opening a side panel leaves the room header and its buttons in place', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const threads = page
    .getByRole('toolbar', { name: en.room.actionsLabel })
    .getByRole('button', { name: en.timeline.threadsOpen });
  await expect(threads).toBeVisible();
  const before = await threads.boundingBox();

  await threads.click();
  await expect(page.getByRole('complementary', { name: en.timeline.threadsTitle })).toBeVisible();
  const after = await threads.boundingBox();

  expect(after).toEqual(before);
});

test('a side panel fills the space beside the timeline', async ({ app, page, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page
    .getByRole('toolbar', { name: en.room.actionsLabel })
    .getByRole('button', { name: en.timeline.threadsOpen })
    .click();
  const panel = page.getByRole('complementary', { name: en.timeline.threadsTitle });
  await expect(panel).toBeVisible();

  const room = await page.getByRole('main', { name: en.timeline.label }).boundingBox();
  const aside = await panel.boundingBox();
  if (room === null || aside === null) throw new Error('the room and its panel must have bounds');
  expect(aside.x + aside.width).toBeCloseTo(room.x + room.width, 0);
});

test('a thread side panel keeps its width beside the timeline', async ({
  app,
  page,
  core,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation: 'panel' }));
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'reset',
      values: [
        {
          ...timelineItem('thread-root', 'Root message'),
          thread_summary: {
            num_replies: 3,
            latest_body: 'a reply',
            latest_sender: '@bob:example.test',
          },
        },
      ],
    },
  ]);

  await page.locator('.thread-summary').first().click();
  const panel = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(panel).toBeVisible();

  const room = await page.getByRole('main', { name: en.timeline.label }).boundingBox();
  const thread = await panel.boundingBox();
  if (room === null || thread === null) throw new Error('the room and its thread must have bounds');
  const rem = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  );
  expect(thread.width).toBeCloseTo(27.5 * rem, 0);
  expect(thread.x + thread.width).toBeCloseTo(room.x + room.width, 0);
});
