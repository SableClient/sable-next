import type { TimelineItemView } from '#src/generated/protocol';
import { expect, SIGNED_OUT, test } from './fixtures/test';
import { timelineItem, withRowFields } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const wide = 'This English paragraph is long enough to widen the message block well past the rest';

const message = (html: string, edited = false): TimelineItemView => ({
  ...timelineItem('general-19', html),
  content: { kind: 'message', body: html, html, msgtype: 'text', edited, jumbo: null },
});

const cases: { label: string; item: TimelineItemView; sides: Record<string, 'left' | 'right'> }[] =
  [
    {
      label: 'mixed paragraphs',
      item: message(`<p>${wide}</p><p>سلام دنیا ۱۲۳ hello</p><p>Sable یک کلاینت است</p>`),
      sides: { [wide]: 'left', 'سلام دنیا ۱۲۳ hello': 'right', 'Sable یک کلاینت است': 'left' },
    },
    {
      label: 'list and quote',
      item: message(
        `<p>${wide}</p><ul><li>مورد اول with English</li></ul><blockquote>نقل قول ۴۵۶</blockquote>`
      ),
      sides: { 'مورد اول with English': 'right', 'نقل قول ۴۵۶': 'right' },
    },
    {
      label: 'line break',
      item: message(`${wide}<br>مرحبا بالعالم 2026`),
      sides: { [wide]: 'left', 'مرحبا بالعالم 2026': 'right' },
    },
    {
      label: 'edited',
      item: message(`<p>${wide}</p><p>ویرایش شده ۷۸۹</p>`, true),
      sides: { 'ویرایش شده ۷۸۹': 'right' },
    },
  ];

for (const layout of ['modern', 'compact', 'bubble'] as const) {
  for (const receipts of [false, true]) {
    test(`${layout} layout aligns each paragraph to its own direction${receipts ? ' beside inline receipts' : ''}`, async ({
      page,
      app,
      core,
      timeline,
      installRoomCore,
    }) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.addInitScript((layout) => {
        localStorage.setItem('sable-preferences', JSON.stringify({ layout }));
      }, layout);
      await installRoomCore('ready');
      await app.openRoom('!room:example.test');
      await timeline.expectRevealed();
      const subscription = await core.subscription();
      let previousId = 'general-19';

      for (const { label, item, sides } of cases) {
        for (const own of [false, true]) {
          const id = `bidi-${label.replaceAll(' ', '-')}-${String(own)}`;
          await core.setTimelineItemById(subscription, previousId, {
            ...withRowFields(item),
            id,
            is_own: own,
            sender: own ? '@e2e:example.test' : '@alice:example.test',
            read_by: receipts ? ['@bob:example.test'] : [],
          });
          previousId = id;
          const row = timeline.itemById(id);
          await expect(row.locator('.formatted-body')).toBeVisible();
          const measured = await row.evaluate((node, texts) => {
            const blockOf = (element: Element): Element => {
              let current: Element | null = element;
              while (current && getComputedStyle(current).display.startsWith('inline'))
                current = current.parentElement;
              return current ?? element;
            };
            const result: Record<string, string> = {};
            const walker = document.createTreeWalker(
              node.querySelector('.formatted-body') ?? node,
              NodeFilter.SHOW_TEXT
            );
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              const content = text.textContent?.trim() ?? '';
              if (!texts.includes(content) || !text.parentElement) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              const line = range.getBoundingClientRect();
              const block = blockOf(text.parentElement);
              const style = getComputedStyle(block);
              const box = block.getBoundingClientRect();
              const left = line.left - box.left - parseFloat(style.paddingLeft);
              const right = box.right - parseFloat(style.paddingRight) - line.right;
              result[content] = right < left ? 'right' : 'left';
            }
            return result;
          }, Object.keys(sides));
          expect(measured, `${label} (${own ? 'sent' : 'received'})`).toEqual(sides);
        }
      }
    });
  }
}
