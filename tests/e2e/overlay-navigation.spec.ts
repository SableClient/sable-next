import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

test('leaving the room while a thread is open lands on the other section', async ({
  app,
  page,
  core,
  installRoomCore,
}) => {
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
  await expect(page.getByRole('region', { name: 'Thread', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Direct messages' }).first().click();

  await expect(page).toHaveURL(/\/direct$/);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/direct$/);
});

test('confirming a leave from its dialog lands on the room list', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Leave room' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();

  await expect(page).toHaveURL(/\/rooms$/);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/rooms$/);
});
