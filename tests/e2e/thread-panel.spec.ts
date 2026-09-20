import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, viewport: { width: 900, height: 800 } });

test('the thread drawer keeps the timeline and the composer inside the viewport', async ({
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
  const panel = page.locator('.thread-panel');
  await expect(panel).toBeVisible();

  const fit = await panel.evaluate((node) => {
    const drawer = node.parentElement;
    if (!drawer) throw new Error('the panel has no drawer');
    const composer = node.querySelector('.thread-composer');
    if (!composer) throw new Error('the panel has no composer');
    return {
      overflow: node.getBoundingClientRect().bottom - drawer.getBoundingClientRect().bottom,
      composer: composer.getBoundingClientRect().bottom - window.innerHeight,
    };
  });

  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.composer).toBeLessThanOrEqual(0);
});
