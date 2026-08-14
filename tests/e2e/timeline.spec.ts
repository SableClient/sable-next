import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/test';
import {
  TIMELINE_MESSAGE_COUNT,
  TIMELINE_ROOM_NAME,
  sendTimelineMessage,
  type TestHomeserver,
} from './fixtures/continuwuity';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { homeserverStatePath } from './fixtures/runtime';
import type { AuthFlow } from './pages/AuthFlow';

type TimelineHomeserver = TestHomeserver & { timelineRoomId: string; accessToken: string };

async function openTimeline(auth: AuthFlow, page: Page): Promise<Locator> {
  const homeserver = JSON.parse(
    await readFile(homeserverStatePath(), 'utf8')
  ) as TimelineHomeserver;
  await page.setViewportSize({ width: 1280, height: 420 });
  await auth.open(homeserver.baseUrl);
  await auth.revealPasswordLogin();
  await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);
  await expect(page).toHaveURL(/\/home$/);
  const room = page.getByRole('link', { name: TIMELINE_ROOM_NAME });
  await expect(room).toBeVisible({ timeout: 15_000 });
  await room.click();
  await expect(page).toHaveURL(`/home/${encodeURIComponent(homeserver.timelineRoomId)}`);
  return page.locator('.timeline-viewport .viewport');
}

test('loads a real room at latest and preserves the viewport while paginating', async ({
  auth,
  page,
}) => {
  test.setTimeout(60_000);
  const viewport = await openTimeline(auth, page);
  const latest = page.getByText(`Timeline message ${String(TIMELINE_MESSAGE_COUNT - 1)}`, {
    exact: true,
  });

  await expect(latest).toBeInViewport({ timeout: 15_000 });
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
        overflow: element.scrollHeight > element.clientHeight,
      }))
    )
    .toEqual({ distance: 0, overflow: true });
  await expect(page.locator('.timeline-content > .loading')).toHaveCount(0);

  await viewport.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.locator('.jump-to-latest')).toBeVisible();
  await viewport.dispatchEvent('wheel', { deltaY: 1 });
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect
    .poll(() =>
      viewport.evaluate((element) => {
        const viewportRect = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll<HTMLElement>('.item')).filter((item) => {
          const itemRect = item.getBoundingClientRect();
          return itemRect.bottom > viewportRect.top && itemRect.top < viewportRect.bottom;
        }).length;
      })
    )
    .toBeGreaterThan(0);
  const anchorId = await viewport.evaluate((element) => {
    const viewportRect = element.getBoundingClientRect();
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('.item[data-event-id]')).find(
      (item) => {
        const itemRect = item.getBoundingClientRect();
        return itemRect.top >= viewportRect.top && itemRect.bottom <= viewportRect.bottom;
      }
    );
    return anchor?.dataset.itemId;
  });
  if (!anchorId) throw new Error('timeline did not render an anchor item');
  const anchor = page.locator(`.timeline-viewport .item[data-item-id=${JSON.stringify(anchorId)}]`);
  const before = await anchor.boundingBox();
  const oldestRenderedMessage = async (): Promise<number> =>
    page.locator('.timeline-viewport .item').evaluateAll((items) => {
      const indexes = items.flatMap((item) => {
        const match = item.textContent.match(/Timeline message (\d+)/);
        return match ? [Number(match[1])] : [];
      });
      return Math.min(...indexes);
    });
  const beforeOldestMessage = await oldestRenderedMessage();

  await page.mouse.wheel(0, -200);
  await expect.poll(oldestRenderedMessage, { timeout: 15_000 }).toBeLessThan(beforeOldestMessage);
  await page.waitForTimeout(500);
  const after = await anchor.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
});

test('keeps the live subscription when another tab restores the shared session', async ({
  auth,
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await openTimeline(auth, page);
  await expect(page.locator('.timeline-content > .loading')).toHaveCount(0);

  const secondPage = await context.newPage();
  await secondPage.goto('/home');
  await expect(secondPage.getByRole('link', { name: TIMELINE_ROOM_NAME })).toBeVisible({
    timeout: 15_000,
  });

  const homeserver = JSON.parse(
    await readFile(homeserverStatePath(), 'utf8')
  ) as TimelineHomeserver;
  const body = `Live after second restore ${String(Date.now())}`;
  await sendTimelineMessage(
    homeserver.baseUrl,
    homeserver.accessToken,
    homeserver.timelineRoomId,
    `live-${String(Date.now())}`,
    body
  );

  await page.bringToFront();
  await expect(page.getByText(body, { exact: true })).toBeInViewport({ timeout: 15_000 });
  await secondPage.close();
});
