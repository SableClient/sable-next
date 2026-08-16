import type { Page } from '@playwright/test';

type TimelineDiff = Record<string, unknown>;

export class FakeCoreDriver {
  constructor(private readonly page: Page) {}

  commands(): Promise<string[]> {
    return this.page.evaluate(() => window.__e2eCommands);
  }

  timelineCommands(): Promise<string[]> {
    return this.page.evaluate(() =>
      window.__e2eCommands.filter(
        (command) => command === 'subscribe_timeline' || command === 'paginate'
      )
    );
  }

  subscribeCount(): Promise<number> {
    return this.page.evaluate(
      () => window.__e2eCommands.filter((command) => command === 'subscribe_timeline').length
    );
  }

  paginateCount(): Promise<number> {
    return this.page.evaluate(
      () => window.__e2eCommands.filter((command) => command === 'paginate').length
    );
  }

  subscription(index = 0): Promise<number> {
    return this.page.evaluate((at) => window.__e2eTimelineSubscriptions[at], index);
  }

  async emitTimelineDiff(subscription: number, diffs: TimelineDiff[]): Promise<void> {
    await this.page.evaluate(
      ({ subscription, diffs }) => {
        window.__e2eEmitTimelineEvent({ type: 'timeline_diff', subscription, diffs });
      },
      { subscription, diffs }
    );
  }

  async emitTyping(roomId: string, userIds: string[]): Promise<void> {
    await this.page.evaluate(
      ({ roomId, userIds }) => {
        window.__e2eEmitTimelineEvent({ type: 'typing', room_id: roomId, user_ids: userIds });
      },
      { roomId, userIds }
    );
  }

  // Samples every frame, so a mid-flight jump cannot hide between two settled
  // measurements.
  async sampleAnchorWhile(
    itemId: string,
    subscription: number,
    diffs: TimelineDiff[],
    durationMs: number
  ): Promise<number[]> {
    return this.page.evaluate(
      async ({ itemId, subscription, diffs, durationMs }) => {
        const positions: number[] = [];
        const sample = (): void => {
          const anchor = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
          if (anchor) positions.push(anchor.getBoundingClientRect().top);
        };
        sample();
        window.__e2eEmitTimelineEvent({ type: 'timeline_diff', subscription, diffs });
        const deadline = performance.now() + durationMs;
        while (performance.now() < deadline) {
          await new Promise(requestAnimationFrame);
          sample();
        }
        return positions;
      },
      { itemId, subscription, diffs, durationMs }
    );
  }
}
