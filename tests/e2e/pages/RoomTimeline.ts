import { expect, type Locator, type Page } from '@playwright/test';

export class RoomTimeline {
  readonly container: Locator;
  readonly viewport: Locator;
  readonly items: Locator;
  readonly initial: Locator;
  readonly skeleton: Locator;
  readonly loading: Locator;
  readonly jumpToLatest: Locator;
  readonly image: Locator;

  constructor(private readonly page: Page) {
    this.container = page.locator('.timeline-viewport');
    this.viewport = page.locator('.timeline-viewport .viewport');
    this.items = page.locator('.timeline-viewport .item');
    this.initial = page.locator('.timeline-viewport.initial');
    this.skeleton = page.locator('.timeline-skeleton');
    this.loading = page.locator('.timeline-content > .loading');
    this.jumpToLatest = page.locator('.jump-to-latest');
    this.image = page.locator('.timeline-viewport .media-image');
  }

  // Scoped to the timeline: the room list renders the latest message as a
  // preview, so an unscoped lookup matches twice.
  message(body: string): Locator {
    return this.container.getByText(body, { exact: true });
  }

  itemById(itemId: string): Locator {
    return this.page.locator(`[data-item-id="${itemId}"]`);
  }

  itemByEventId(eventId: string): Locator {
    return this.page.locator(`[data-event-id="${eventId}"]`);
  }

  itemByIndex(index: number): Locator {
    return this.page.locator(`[data-index="${String(index)}"]`);
  }

  visibleItems(): Locator {
    return this.items.filter({ visible: true });
  }

  distanceFromBottom(): Promise<number> {
    return this.viewport.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight
    );
  }

  scrollableHeight(): Promise<number> {
    return this.viewport.evaluate((element) => element.scrollHeight - element.clientHeight);
  }

  scrollTop(): Promise<number> {
    return this.viewport.evaluate((element) => element.scrollTop);
  }

  async scrollTo(offset: number): Promise<void> {
    await this.viewport.evaluate((element, value) => {
      element.scrollTop = value;
    }, offset);
  }

  async scrollToAndNotify(offset: number): Promise<void> {
    await this.viewport.evaluate((element, value) => {
      element.scrollTop = value;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, offset);
  }

  async scrollToBottomAndNotify(): Promise<void> {
    await this.viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }

  async scrollToMiddleAndNotify(): Promise<void> {
    await this.viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }

  async scrollAboveBottomAndNotify(gap: number): Promise<void> {
    await this.viewport.evaluate((element, value) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - value);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, gap);
  }

  async wheelUp(distance: number): Promise<void> {
    await this.viewport.hover();
    await this.page.mouse.wheel(0, -distance);
  }

  async dispatchWheel(deltaY: number): Promise<void> {
    await this.viewport.dispatchEvent('wheel', { deltaY });
  }

  offsetOfIndex(index: number): Promise<number> {
    return this.itemByIndex(index).evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      return transform === 'none' ? 0 : new DOMMatrix(transform).m42;
    });
  }

  async anchorAt(nth: number, { visibleOnly = false } = {}): Promise<TimelineAnchor> {
    const locator = visibleOnly ? this.visibleItems().nth(nth) : this.items.nth(nth);
    const itemId = await locator.getAttribute('data-item-id');
    if (!itemId) throw new Error(`timeline item ${String(nth)} has no data-item-id`);
    const box = await locator.boundingBox();
    if (!box) throw new Error(`timeline item ${String(nth)} has no bounds`);
    return { itemId, y: box.y };
  }

  // A partially clipped row shifts on its own as history lands, so an anchor
  // has to be one the viewport already contains whole.
  async fullyVisibleAnchor(): Promise<TimelineAnchor> {
    const itemId = await this.viewport.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('.item[data-event-id]')).find(
        (item) => {
          const rect = item.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        }
      );
      return anchor?.dataset.itemId;
    });
    if (!itemId) throw new Error('timeline rendered no fully visible anchor');
    const box = await this.itemById(itemId).boundingBox();
    if (!box) throw new Error(`timeline item ${itemId} has no bounds`);
    return { itemId, y: box.y };
  }

  // The local echo and the confirmed event coexist until the SDK dedupes them,
  // so the message is briefly rendered twice.
  async expectMessageSettled(body: string, { timeout = 15_000 } = {}): Promise<void> {
    await expect(this.message(body)).toHaveCount(1, { timeout });
    // The viewport stays hidden until the initial anchor lands, which is the
    // slow part under load, so this gets the same budget as the count.
    await expect(this.message(body).first()).toBeVisible({ timeout });
  }

  async expectAnchorHeld(anchor: TimelineAnchor, { tolerance = 0.5 } = {}): Promise<void> {
    await expect
      .poll(async () => {
        const box = await this.itemById(anchor.itemId).boundingBox();
        return box ? Math.abs(box.y - anchor.y) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(tolerance);
  }

  async expectAtLatest(lastBody: string): Promise<void> {
    const lastItem = this.message(lastBody);
    await expect(lastItem).toBeVisible();
    await expect.poll(() => this.distanceFromBottom()).toBe(0);

    const [itemBox, viewportBox] = await Promise.all([
      lastItem.boundingBox(),
      this.viewport.boundingBox(),
    ]);
    expect(itemBox).not.toBeNull();
    expect(viewportBox).not.toBeNull();
    expect((itemBox?.y ?? 0) + (itemBox?.height ?? 0)).toBeLessThanOrEqual(
      (viewportBox?.y ?? 0) + (viewportBox?.height ?? 0) + 2
    );
    expect(itemBox?.y).toBeGreaterThanOrEqual((viewportBox?.y ?? 0) - 2);
  }
}

export type TimelineAnchor = {
  itemId: string;
  y: number;
};
