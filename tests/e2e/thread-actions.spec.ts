import type { Locator } from '@playwright/test';
import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const surface of ['room', 'forum'] as const) {
  for (const presentation of ['timeline', 'panel'] as const) {
    test(`${surface} ${presentation} actions target the thread with mouse and touch`, async ({
      app,
      page,
      core,
      installRoomCore,
      isMobile,
    }) => {
      await page.setViewportSize({ width: isMobile ? 412 : 1400, height: 900 });
      await page.addInitScript((threadPresentation) => {
        localStorage.setItem('sable-preferences', JSON.stringify({ threadPresentation }));
      }, presentation);
      await installRoomCore(surface === 'forum' ? 'forum' : 'ready');
      if (surface === 'forum') await page.goto('/rooms/!room%3Aexample.test');
      else await app.openRoom('!room:example.test');

      const parent = page.locator(surface === 'forum' ? '.forum-main' : '.room-view > .timeline');
      await expect(parent.locator('[contenteditable="true"]').first()).toBeVisible({
        timeout: 45_000,
      });
      const root = {
        ...timelineItem('root', 'Original discussion'),
        thread_summary: {
          num_replies: 2,
          latest_body: 'A reply',
          latest_sender: '@bob:example.test',
        },
      };
      await core.emitTimelineDiff(await core.subscription(), [{ op: 'reset', values: [root] }]);
      const opener = parent.locator(surface === 'forum' ? '.forum-thread-meta' : '.thread-summary');
      await expect(opener).toHaveCount(1);
      await opener.click();
      const thread = page.getByRole('region', { name: en.timeline.thread, exact: true });
      await expect(thread).toBeVisible();
      await core.emitTimelineDiff(await core.subscription(1), [
        {
          op: 'reset',
          values: [
            root,
            { ...timelineItem('reply', 'Reply from Alice'), thread_root: root.event_id },
            {
              ...timelineItem('own', 'My earlier reply'),
              thread_root: root.event_id,
              is_own: true,
            },
          ],
        },
      ]);
      await expect(thread.locator('[data-item-id="own"]')).toBeVisible();

      const commands = () => page.evaluate(() => window.__e2eCommandPayloads);
      const editor = thread.locator('[contenteditable="true"]').first();
      await editor.fill('New thread reply');
      await thread.getByRole('button', { name: en.timeline.sendMessage, exact: true }).click();
      await expect.poll(commands).toContainEqual(
        expect.objectContaining({
          type: 'send_message',
          room_id: '!room:example.test',
          body: 'New thread reply',
          thread_root: root.event_id,
        })
      );
      await expect(editor).toBeEmpty();

      const reply = thread.locator('[data-item-id="reply"] .message');
      const actionRole = isMobile ? 'button' : 'menuitem';
      const actions = isMobile
        ? page.getByRole('dialog', { name: en.timeline.moreActions, exact: true })
        : page.getByRole('menu');
      async function openActions(message: Locator): Promise<void> {
        if (isMobile) {
          await message.scrollIntoViewIfNeeded();
          const box = await message.boundingBox();
          if (!box) throw new Error('the message has no box');
          const pointer = {
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            clientX: box.x + 10,
            clientY: box.y + 10,
          };
          await message.dispatchEvent('pointerdown', pointer);
          await expect(actions).toBeVisible();
          await message.dispatchEvent('pointerup', pointer);
        } else {
          await message.click({ button: 'right' });
          await expect(actions).toBeVisible();
        }
      }
      await openActions(reply);
      await actions.getByRole(actionRole, { name: en.timeline.reply, exact: true }).click();
      await editor.fill('Answer to Alice');
      await thread.getByRole('button', { name: en.timeline.sendMessage, exact: true }).click();
      await expect.poll(commands).toContainEqual(
        expect.objectContaining({
          type: 'send_message',
          body: 'Answer to Alice',
          thread_root: root.event_id,
          in_reply_to: '$reply:example.test',
        })
      );

      await openActions(thread.locator('[data-item-id="own"] .message'));
      await actions.getByRole(actionRole, { name: en.timeline.editMessage, exact: true }).click();
      await expect(editor).toHaveText('My earlier reply');
      await editor.fill('Edited thread reply');
      await editor.press('Enter');
      await expect.poll(commands).toContainEqual(
        expect.objectContaining({
          type: 'edit_message',
          event_id: '$own:example.test',
          body: 'Edited thread reply',
          thread_root: root.event_id,
        })
      );

      await openActions(reply);
      await expect(
        actions.getByRole(actionRole, { name: en.timeline.addReaction, exact: true })
      ).toBeVisible();
      await expect(
        actions.getByRole(actionRole, { name: en.timeline.copyMessageLink, exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(thread).toBeVisible();

      await openActions(reply);
      await actions.locator('.quick-reaction').first().click();
      await expect.poll(commands).toContainEqual(
        expect.objectContaining({
          type: 'react',
          event_id: '$reply:example.test',
          key: '🎉',
          thread_root: root.event_id,
        })
      );
      await openActions(reply);
      await actions.getByRole(actionRole, { name: en.timeline.pinMessage, exact: true }).click();
      await expect.poll(commands).toContainEqual(
        expect.objectContaining({
          type: 'set_pinned',
          room_id: '!room:example.test',
          event_id: '$reply:example.test',
          pinned: true,
        })
      );

      if (presentation === 'panel' && !isMobile) {
        const resize = thread.getByRole('slider', { name: en.timeline.resizeThread });
        await resize.press('ArrowRight');
        const savedWidth = await resize.getAttribute('aria-valuenow');
        expect(await page.evaluate(() => localStorage.getItem('sable-thread-panel-width'))).toBe(
          savedWidth
        );
      } else {
        await expect(thread.getByRole('slider', { name: en.timeline.resizeThread })).toHaveCount(0);
      }
    });
  }
}
