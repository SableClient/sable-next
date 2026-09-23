import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, viewport: { width: 900, height: 800 } });

test('the thread screen keeps the timeline and the composer inside the viewport', async ({
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
    const screen = node.parentElement;
    if (!screen) throw new Error('the panel has no screen');
    const composer = node.querySelector('.thread-composer');
    if (!composer) throw new Error('the panel has no composer');
    return {
      overflow: node.getBoundingClientRect().bottom - screen.getBoundingClientRect().bottom,
      composer: composer.getBoundingClientRect().bottom - window.innerHeight,
    };
  });

  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.composer).toBeLessThanOrEqual(0);
});

test.describe('on mobile', () => {
  test.use({ viewport: { width: 412, height: 839 } });

  test('a thread covers the timeline and a swipe right closes it', async ({
    app,
    page,
    core,
    installRoomCore,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'touch is driven over CDP');
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
    const panel = page.getByRole('complementary', { name: 'Thread' });
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    if (!box) throw new Error('the panel has no box');
    expect(box.x).toBe(0);
    expect(box.width).toBe(page.viewportSize()?.width);

    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });
    await touch('touchStart', 40);
    for (let x = 60; x <= 300; x += 40) await touch('touchMove', x);
    await touch('touchEnd', 300);

    await expect(panel).toBeHidden();
  });
});
