import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const [surface, mode, path] of [
  ['room', 'ready', '/rooms/!room%3Aexample.test'],
  ['direct', 'direct', '/direct/!room%3Aexample.test'],
  ['forum', 'forum', '/rooms/!room%3Aexample.test'],
  ['voice', 'voice', '/rooms/!voice%3Aexample.test'],
  ['calendar', 'calendar', '/rooms/!room%3Aexample.test?timeline=events'],
  ['space', 'spaces', '/rooms/!alpha%3Aexample.test?timeline=events'],
] as const) {
  for (const presentation of ['timeline', 'panel'] as const) {
    test(`touch: ${surface} ${presentation} thread quotes jump to messages`, async ({
      page,
      core,
      installRoomCore,
      isMobile,
    }) => {
      await page.setViewportSize({ width: isMobile ? 412 : 1400, height: 900 });
      await page.addInitScript((threadPresentation) => {
        localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation }));
      }, presentation);
      await installRoomCore(mode);
      await page.goto(path);
      if (surface === 'voice') {
        await page.getByRole('button', { name: 'Show chat', exact: true }).click();
      }
      const root = {
        ...timelineItem('root', 'Original discussion'),
        thread_summary: {
          num_replies: 32,
          latest_body: 'A reply',
          latest_sender: '@alice:example.test',
        },
      };
      await expect.poll(() => core.subscribeCount()).toBe(1);
      await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values: [root] }]);
      await page.locator(surface === 'forum' ? '.forum-thread-meta' : '.thread-summary').click();
      const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
      await expect(thread).toBeVisible();
      await expect.poll(() => core.subscribeCount()).toBe(2);
      const subscription = await core.subscription(1);
      const target = { ...timelineItem('target', 'Quoted message'), thread_root: root.event_id };
      const reply = {
        ...timelineItem('reply', 'Answer to the quoted message'),
        thread_root: root.event_id,
        in_reply_to: {
          event_id: target.event_id,
          sender: '@alice:example.test',
          sender_name: 'Alice',
          sender_mentioned: false,
          body: 'Quoted message',
          fallback: null,
        },
      };
      await core.emitTimelineDiff(subscription, [
        {
          op: 'reset',
          values: [
            root,
            target,
            ...historyItems({
              idPrefix: 'thread-history',
              label: 'Thread history',
              count: 30,
              timestampBase: 1_700_000_000_000,
            }).map((item) => ({ ...item, thread_root: root.event_id })),
            reply,
          ],
        },
      ]);
      const quote = thread.locator('[data-item-id="reply"] .reply-preview');
      await expect(quote).toBeInViewport();
      await expect(thread.locator('[data-item-id="target"]')).not.toBeInViewport();
      await quote.click();
      await expect(thread.locator('[data-item-id="target"]')).toBeInViewport();
      expect(await core.subscribeCount()).toBe(2);

      const older = { ...target, id: 'older', event_id: '$older:example.test' };
      await core.emitTimelineDiff(subscription, [
        {
          op: 'reset',
          values: [
            root,
            { ...reply, in_reply_to: { ...reply.in_reply_to, event_id: older.event_id } },
          ],
        },
      ]);
      await quote.click();
      await expect
        .poll(() => page.evaluate(() => window.__e2eTimelineFocus.at(-1)))
        .toEqual({ kind: 'event', event_id: older.event_id });
      await core.emitTimelineDiff(await core.subscription(2), [
        { op: 'reset', values: [root, older] },
      ]);
      await expect(thread.locator('[data-item-id="older"]')).toBeInViewport();
      await thread.getByRole('button', { name: en.timeline.jumpToLatest, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.__e2eTimelineFocus.at(-1)))
        .toEqual({ kind: 'thread', root_event_id: root.event_id });
      await expect(thread).toBeVisible();
      expect(new URL(page.url()).searchParams.has('event')).toBe(false);
    });
  }
}
