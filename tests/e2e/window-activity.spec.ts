import { expect, test, type Page } from '@playwright/test';

import type { Command } from '#src/generated/protocol';

import { installFakeCore } from './fake-core';
import { timelineItem } from './fixtures/timeline-items';
import { FakeCoreDriver } from './pages/FakeCoreDriver';
import { RoomTimeline } from './pages/RoomTimeline';

declare global {
  interface Window {
    __e2eActivityCommands: Command[];
    __e2eWindowFocused: boolean;
  }
}

test.use({ storageState: { cookies: [], origins: [] } });

function lastCommand(page: Page, type: Command['type']): Promise<Command | undefined> {
  return page.evaluate(
    (type) => window.__e2eActivityCommands.filter((command) => command.type === type).at(-1),
    type
  );
}

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, 'ready');
  await page.addInitScript(() => {
    window.__e2eWindowFocused = true;
    document.hasFocus = () => window.__e2eWindowFocused;
    window.__e2eActivityCommands = [];
    const Worker = window.SharedWorker;
    Object.defineProperty(window, 'SharedWorker', {
      configurable: true,
      value: class extends Worker {
        constructor(...args: ConstructorParameters<typeof SharedWorker>) {
          super(...args);
          const send = this.port.postMessage.bind(this.port);
          this.port.postMessage = (message: { command?: Command }) => {
            if (message.command) window.__e2eActivityCommands.push(message.command);
            send(message);
          };
        }
      },
    });
  });
});

test('background messages stay unread until focus returns', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const timeline = new RoomTimeline(page);
  const core = new FakeCoreDriver(page);
  await page.goto(`/rooms/${encodeURIComponent('!room:example.test')}`);
  await timeline.expectRevealed({ timeout: 30_000 });
  await expect(timeline.message('General message 19')).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.__e2eCommands)).toContain('mark_read');

  await page.evaluate(() => {
    window.__e2eWindowFocused = false;
    window.dispatchEvent(new Event('blur'));
  });
  await expect
    .poll(() => lastCommand(page, 'set_read_room'))
    .toEqual({ type: 'set_read_room', room_id: null });
  await expect
    .poll(() => lastCommand(page, 'set_presence'))
    .toEqual({ type: 'set_presence', presence: 'unavailable', status_message: null });

  // Wait for receipts queued before blur.
  await page.waitForTimeout(650);
  const receipts = await page.evaluate(
    () => window.__e2eCommands.filter((type) => type === 'mark_read').length
  );
  await core.emitTimelineDiff(await core.subscription(), [
    { op: 'push_back', value: timelineItem('background-message', 'Arrived in the background') },
  ]);
  await expect(timeline.message('Arrived in the background')).toBeInViewport();
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  expect(
    await page.evaluate(() => window.__e2eCommands.filter((type) => type === 'mark_read').length)
  ).toBe(receipts);

  await page.evaluate(() => {
    window.__e2eWindowFocused = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect
    .poll(() => lastCommand(page, 'set_read_room'))
    .toEqual({ type: 'set_read_room', room_id: '!room:example.test' });
  await expect
    .poll(() => lastCommand(page, 'set_presence'))
    .toEqual({ type: 'set_presence', presence: 'online', status_message: null });
  await expect
    .poll(() =>
      page.evaluate(() => window.__e2eCommands.filter((type) => type === 'mark_read').length)
    )
    .toBeGreaterThan(receipts);
  expect(errors).toEqual([]);
});

for (const background of ['blur', 'hidden'] as const) {
  test(`keeps a jump to missed messages after ${background}`, async ({ page }) => {
    const timeline = new RoomTimeline(page);
    const core = new FakeCoreDriver(page);
    await page.goto(`/rooms/${encodeURIComponent('!room:example.test')}`);
    await timeline.expectRevealed({ timeout: 30_000 });
    await expect(timeline.message('General message 19')).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.__e2eCommands)).toContain('mark_read');

    await page.evaluate((background) => {
      if (background === 'blur') {
        window.__e2eWindowFocused = false;
        window.dispatchEvent(new Event('blur'));
      } else {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }, background);
    await page.waitForTimeout(650);
    const receipts = await page.evaluate(
      () => window.__e2eCommands.filter((type) => type === 'mark_read').length
    );
    await core.emitTimelineDiff(await core.subscription(), [
      { op: 'push_back', value: timelineItem('missed-0', 'Missed message 0') },
    ]);
    await expect(timeline.message('Missed message 0')).toBeInViewport();
    await core.emitTimelineDiff(
      await core.subscription(),
      Array.from({ length: 29 }, (_, index) => ({
        op: 'push_back' as const,
        value: timelineItem(`missed-${index + 1}`, `Missed message ${index + 1}`),
      }))
    );
    await expect(timeline.message('Missed message 29')).toBeInViewport();
    await expect(timeline.message('Missed message 0')).not.toBeInViewport();
    const jump = page.getByRole('button', { name: 'Jump to unread' });
    await expect(jump).toBeVisible();
    await expect(jump).toContainText('30 new messages');

    await page.evaluate((background) => {
      if (background === 'blur') {
        window.__e2eWindowFocused = true;
        window.dispatchEvent(new Event('focus'));
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }, background);
    await page.waitForTimeout(650);
    await expect(jump).toBeVisible();
    expect(
      await page.evaluate(() => window.__e2eCommands.filter((type) => type === 'mark_read').length)
    ).toBe(receipts);

    await jump.click();
    await expect(timeline.message('Missed message 0')).toBeInViewport();
    await expect
      .poll(() =>
        page.evaluate(() => window.__e2eCommands.filter((type) => type === 'mark_read').length)
      )
      .toBeGreaterThan(receipts);
    await timeline.scrollToBottomAndNotify();
    await expect(page.getByRole('button', { name: 'Jump to unread' })).toHaveCount(0);
  });
}

for (const choice of [
  { name: 'manual offline status', presence: 'offline', sendPresence: true, expected: 'offline' },
  {
    name: 'manual away status',
    presence: 'unavailable',
    sendPresence: true,
    expected: 'unavailable',
  },
  { name: 'presence privacy', presence: 'online', sendPresence: false, expected: 'offline' },
] as const) {
  test(`keeps ${choice.name} when window focus changes`, async ({ page }) => {
    await page.addInitScript(
      (preferences) => {
        localStorage.setItem('sable-preferences', JSON.stringify(preferences));
      },
      {
        presence: choice.presence,
        sendPresence: choice.sendPresence,
        presenceStatusMessage: 'Back later',
      }
    );
    await page.goto(`/rooms/${encodeURIComponent('!room:example.test')}`);
    await new RoomTimeline(page).expectRevealed({ timeout: 30_000 });
    await expect
      .poll(() => lastCommand(page, 'set_read_room'))
      .toEqual({ type: 'set_read_room', room_id: '!room:example.test' });

    for (const focused of [false, true]) {
      await page.evaluate((next) => {
        window.__e2eWindowFocused = next;
        window.dispatchEvent(new Event(next ? 'focus' : 'blur'));
      }, focused);
      await expect
        .poll(() => lastCommand(page, 'set_read_room'))
        .toEqual({ type: 'set_read_room', room_id: focused ? '!room:example.test' : null });
      expect(await lastCommand(page, 'set_presence')).toEqual({
        type: 'set_presence',
        presence: choice.expected,
        status_message: choice.sendPresence ? 'Back later' : null,
      });
    }
  });
}
