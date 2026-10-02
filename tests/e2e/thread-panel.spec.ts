import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT, viewport: { width: 900, height: 800 }, hasTouch: true });

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
  const panel = page.getByRole('region', { name: en.timeline.thread, exact: true });
  await expect(panel).toBeVisible();
  await expect(page.locator('.room-view > .timeline')).toBeHidden();
  await expect(page.getByRole('dialog', { name: en.timeline.thread })).toHaveCount(0);

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
  await page.screenshot({ path: test.info().outputPath('thread.png') });
});

test('the formatting toolbar keeps the thread composer inside the timeline', async ({
  app,
  page,
  core,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ formattingToolbar: true }));
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
  await expect(panel.locator('.thread-composer .formatting')).toBeVisible();

  const fit = await panel.evaluate((node) => {
    const composer = node.querySelector('.thread-composer');
    if (!composer) throw new Error('the panel has no composer');
    return {
      composer: composer.getBoundingClientRect().right - node.getBoundingClientRect().right,
      overflow: node.scrollWidth - node.clientWidth,
    };
  });

  expect(fit.composer).toBeLessThanOrEqual(0.5);
  expect(fit.overflow).toBeLessThanOrEqual(0);
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
    const panel = page.getByRole('region', { name: 'Thread' });
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

test.describe('in place of the room', () => {
  test.use({ viewport: { width: 1400, height: 800 } });

  test('a right-click opens one message menu while a thread is open', async ({
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
    await expect(page.getByRole('region', { name: en.timeline.thread, exact: true })).toBeVisible();

    await page.locator('.thread-view .message').first().click({ button: 'right' });
    await expect(page.locator('.message-menu').first()).toBeVisible();
    await expect(page.locator('.message-menu')).toHaveCount(1);
  });
});

for (const context of ['desktop', 'mobile'] as const) {
  for (const surface of ['room', 'forum'] as const) {
    test(`${surface} ${context} thread navigation preserves the parent view`, async ({
      app,
      page,
      core,
      installRoomCore,
    }) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await installRoomCore(surface === 'forum' ? 'forum' : 'ready');
      if (surface === 'forum') await page.goto('/rooms/!room%3Aexample.test');
      else await app.openRoom('!room:example.test');
      const parent = page.locator(surface === 'forum' ? '.forum-main' : '.room-view > .timeline');
      const editor = parent.locator('[contenteditable="true"]').first();
      await expect(editor).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (surface === 'room') await parent.locator('.members-button').click();
      await editor.fill('Unsent parent draft');
      const subscription = await core.subscription();
      await core.emitTimelineDiff(subscription, [
        {
          op: 'reset',
          values: Array.from({ length: 40 }, (_, index) => ({
            ...timelineItem(`root-${index}`, `Discussion ${index}`),
            thread_summary: {
              num_replies: 3,
              latest_body: 'A reply',
              latest_sender: '@bob:example.test',
            },
          })),
        },
      ]);
      const opener = parent
        .locator(surface === 'forum' ? '.forum-thread-meta' : '.thread-summary')
        .last();
      await opener.scrollIntoViewIfNeeded();
      await expect(opener).toBeVisible();
      await opener.focus();
      const positionBefore = await opener.evaluate((node) => node.getBoundingClientRect().top);
      await opener.press('Enter');
      const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
      await expect(thread).toBeVisible();
      await expect(parent).toBeHidden();
      await expect(thread).toBeFocused();
      await expect(thread.locator('.subtitle')).toHaveText('General');
      await expect(thread.locator('.resize-handle')).toHaveCount(0);
      await core.emitTimelineDiff(await core.subscription(1), [
        {
          op: 'reset',
          values: [
            {
              ...timelineItem('root-39', 'A place to discuss the next Sable release'),
              thread_root: null,
            },
            ...Array.from({ length: 12 }, (_, index) => ({
              ...timelineItem(`reply-${index}`, `Thread reply ${index + 1}`),
              thread_root: '$root-39:example.test',
            })),
          ],
        },
      ]);
      await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);
      const threadEditor = thread.locator('[contenteditable="true"]').first();
      await threadEditor.fill('Unsent thread draft');
      await page.screenshot({ path: test.info().outputPath(`${surface}-desktop.png`) });
      await thread
        .getByRole('button', {
          name: surface === 'forum' ? en.forum.backToForum : en.timeline.backToConversation,
          exact: true,
        })
        .click();
      await expect(thread).toBeHidden();
      await expect(parent).toBeVisible();
      await expect(editor).toHaveText('Unsent parent draft');
      await expect(opener).toBeFocused();
      await expect
        .poll(() => opener.evaluate((node) => node.getBoundingClientRect().top))
        .toBeCloseTo(positionBefore, 0);
      await opener.click();
      await expect(thread).toBeVisible();
      await threadEditor.fill('Unsent thread draft');
      const subscribeCount = await core.subscribeCount();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(threadEditor).toHaveText('Unsent thread draft');
      expect(await core.subscribeCount()).toBe(subscribeCount);
      await page.screenshot({ path: test.info().outputPath(`${surface}-mobile.png`) });
      await page.goBack();
      await expect(thread).toBeHidden();
      await expect(parent).toBeVisible();
      await expect
        .poll(() => decodeURIComponent(new URL(page.url()).pathname))
        .toBe('/rooms/!room:example.test');
      await expect(editor).toHaveText('Unsent parent draft');
      await page.setViewportSize({ width: 1400, height: 900 });
      await opener.click();
      await expect(thread).toBeVisible();
      await thread.press('Escape');
      await expect(thread).toBeHidden();
    });
  }
}

for (const context of ['desktop', 'mobile'] as const) {
  for (const surface of ['room', 'forum'] as const) {
    test(`${surface} ${context} panel preference follows the viewport without losing the draft`, async ({
      app,
      page,
      core,
      installRoomCore,
    }) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.addInitScript(() => {
        localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation: 'panel' }));
      });
      await installRoomCore(surface === 'forum' ? 'forum' : 'ready');
      if (surface === 'forum') await page.goto('/rooms/!room%3Aexample.test');
      else await app.openRoom('!room:example.test');
      const parent = page.locator(surface === 'forum' ? '.forum-main' : '.room-view > .timeline');
      if (surface === 'room') await parent.locator('.members-button').click();
      await expect(parent.locator('[contenteditable="true"]').first()).toBeVisible();
      await core.emitTimelineDiff(await core.subscription(), [
        {
          op: 'reset',
          values: [
            {
              ...timelineItem('root', 'Discussion about the next release '.repeat(8)),
              thread_summary: {
                num_replies: 2,
                latest_body: 'A reply',
                latest_sender: '@bob:example.test',
              },
            },
          ],
        },
      ]);
      const opener = parent.locator(surface === 'forum' ? '.forum-thread-meta' : '.thread-summary');
      await expect(opener).toHaveCount(1);
      await opener.click();
      const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
      await expect(parent).toBeVisible();
      await expect(thread).toHaveClass(/side-panel/);
      await core.emitTimelineDiff(await core.subscription(1), [
        {
          op: 'reset',
          values: [
            {
              ...timelineItem('root', 'Discussion about the next release '.repeat(8)),
              thread_root: null,
            },
            ...Array.from({ length: 30 }, (_, index) => ({
              ...timelineItem(`reply-${index}`, `Reply ${index + 1} to the release discussion`),
              thread_root: '$root:example.test',
            })),
          ],
        },
      ]);
      await expect(thread.getByRole('button', { name: en.timeline.jumpToOriginal })).toBeVisible();
      await thread.getByRole('button', { name: en.timeline.jumpToOriginal }).click();
      await expect(thread.locator('.thread-original')).toBeVisible();
      await expect(thread.getByRole('slider', { name: en.timeline.resizeThread })).toBeVisible();
      const editor = thread.locator('[contenteditable="true"]').first();
      await editor.fill('Keep my thread draft');
      const subscriptions = await core.subscribeCount();
      await page.screenshot({ path: test.info().outputPath(`${surface}-panel-desktop.png`) });
      await page.setViewportSize({ width: 320, height: 740 });
      await expect(parent).toBeHidden();
      await expect(thread).not.toHaveClass(/side-panel/);
      await expect(editor).toHaveText('Keep my thread draft');
      expect(await core.subscribeCount()).toBe(subscriptions);
      const dimensions = await thread.evaluate((node) => {
        const headerButton = node.querySelector('.panel-header-button');
        if (!headerButton) throw new Error('Missing thread navigation button');
        const composerButtons = [...node.querySelectorAll('.composer-stack .icon-button-small')];
        return {
          overflow: node.scrollWidth - node.clientWidth,
          header: headerButton.getBoundingClientRect().width,
          composer: composerButtons.map((button) => {
            const hit = getComputedStyle(button, '::after');
            return (
              button.getBoundingClientRect().width - parseFloat(hit.left) - parseFloat(hit.right)
            );
          }),
        };
      });
      expect(dimensions.overflow).toBeLessThanOrEqual(1);
      expect(dimensions.header).toBeGreaterThanOrEqual(44);
      expect(dimensions.composer.every((width) => width >= 44)).toBe(true);
      await expect(thread.locator('.composer-row')).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            })
          )
      );
      await page.screenshot({ path: test.info().outputPath(`${surface}-panel-mobile.png`) });
      await page.setViewportSize({ width: 1400, height: 900 });
      await expect(parent).toBeVisible();
      await expect(editor).toHaveText('Keep my thread draft');
      await thread.getByRole('button', { name: en.timeline.threadClose, exact: true }).click();
      await expect(thread).toBeHidden();
    });
  }
}

for (const context of ['desktop', 'mobile'] as const) {
  test(`${context} failed thread loading retries while keeping the draft`, async ({
    app,
    page,
    core,
    installRoomCore,
  }) => {
    if (context === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await installRoomCore('thread_error');
    await app.openRoom('!room:example.test');
    await core.emitTimelineDiff(await core.subscription(), [
      {
        op: 'reset',
        values: [
          {
            ...timelineItem('root', 'Release discussion'),
            thread_summary: {
              num_replies: 2,
              latest_body: 'A reply',
              latest_sender: '@bob:example.test',
            },
          },
        ],
      },
    ]);
    await page.locator('.thread-summary').click();
    const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
    const editor = thread.locator('[contenteditable="true"]').first();
    await expect(thread.getByRole('heading', { name: 'Release discussion' })).toBeVisible();
    await editor.fill('Keep draft after retry');
    await expect(thread.getByRole('button', { name: en.timeline.retryLoad })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('thread-failed.png') });
    await thread.getByRole('button', { name: en.timeline.retryLoad }).click();
    await expect(thread.getByRole('button', { name: en.timeline.retryLoad })).toHaveCount(0);
    await expect(thread.locator('.message').first()).toBeVisible();
    await expect(editor).toHaveText('Keep draft after retry');
  });
}

for (const threadPresentation of ['timeline', 'panel']) {
  test(`leaving a thread restores the members drawer (${threadPresentation})`, async ({
    page,
    app,
    core,
    timeline,
    installRoomCore,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript((threadPresentation) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation }));
    }, threadPresentation);
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await timeline.expectRevealed();
    await expect(page.locator('.members-drawer')).toBeVisible();
    const subscription = await core.subscription();
    await core.setTimelineItemById(subscription, 'general-19', {
      ...timelineItem('general-19', 'Thread root'),
      thread_summary: {
        num_replies: 3,
        latest_body: 'Reply',
        latest_sender: '@alice:example.test',
      },
    });
    await page.locator('[data-item-id="general-19"] .thread-summary').click();
    const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
    await expect(thread).toBeVisible();
    await expect(page.locator('.members-drawer')).toBeHidden();
    await thread
      .getByRole('button', {
        name:
          threadPresentation === 'panel' ? en.timeline.threadClose : en.timeline.backToConversation,
      })
      .click();
    await expect(page.locator('.members-drawer')).toBeVisible();
  });
}

for (const threadPresentation of ['timeline', 'panel']) {
  test(`threads load older messages without pagination errors (${threadPresentation})`, async ({
    page,
    app,
    core,
    timeline,
    installRoomCore,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript((threadPresentation) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation }));
    }, threadPresentation);
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await timeline.expectRevealed();
    const subscription = await core.subscription();
    await core.setTimelineItemById(subscription, 'general-19', {
      ...timelineItem('general-19', 'Thread root'),
      thread_summary: {
        num_replies: 3,
        latest_body: 'Reply',
        latest_sender: '@alice:example.test',
      },
    });
    await page.locator('[data-item-id="general-19"] .thread-summary').click();
    const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
    await expect(thread).toBeVisible();
    const threadSubscription = await core.subscription(1);
    await thread.locator('.viewport').hover();
    await page.mouse.wheel(0, -1000);
    await expect
      .poll(() =>
        page.evaluate(
          (subscription) =>
            window.__e2eCommandPayloads
              .filter(
                (command) => command.type === 'paginate' && command.subscription === subscription
              )
              .map((command) => (command.type === 'paginate' ? command.direction : null)),
          threadSubscription
        )
      )
      .toContain('backward');
    expect(await page.evaluate(() => window.__e2ePaginationDirections)).not.toContain('forward');
    await expect(thread.getByText(en.timeline.loadFailed)).toHaveCount(0);
  });
}
