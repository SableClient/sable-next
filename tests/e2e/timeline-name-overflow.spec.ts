import { expect, SIGNED_OUT, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const name of [
  'A very long display name with spaces and emoji 🍺 🔥 '.repeat(4),
  'AnUnbrokenDisplayName'.repeat(12),
]) {
  test(`mobile: long names stay inside the timeline (${name.includes(' ') ? 'spaced' : 'unbroken'})`, async ({
    app,
    core,
    page,
    timeline,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await timeline.expectRevealed();
    await core.emitTimelineDiff(await core.subscription(), [
      {
        op: 'push_back',
        value: {
          ...timelineItem('long-name-message', 'Message with a long sender name'),
          sender_name: name,
        },
      },
      {
        op: 'push_back',
        value: {
          ...timelineItem('long-name-ban', ''),
          content: {
            kind: 'membership',
            user_id: '@departed:example.test',
            display_name: name,
            change: 'kicked_and_banned',
            reason: 'Moderation reason',
          },
        },
      },
    ]);

    const subject = page.locator('.state-subject', { hasText: name });
    await expect(subject).toBeVisible();
    await expect(page.locator('.state-event-text', { has: subject })).toContainText(
      'Moderation reason'
    );
    await expect(async () => {
      const overflowing = await timeline.container.evaluate((node) => {
        const elements = [node, ...node.querySelectorAll('*')];
        return elements
          .filter((element) => {
            const overflow = getComputedStyle(element).overflowX;
            return (
              (overflow === 'auto' || overflow === 'scroll') &&
              element.scrollWidth > element.clientWidth + 1
            );
          })
          .map((element) => element.getAttribute('class') ?? element.tagName);
      });
      expect(overflowing).toEqual([]);
    }).toPass({ timeout: 5_000 });
    await subject.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}
