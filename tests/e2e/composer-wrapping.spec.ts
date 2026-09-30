import type { Locator } from '@playwright/test';

import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

async function measure(composer: Locator) {
  return composer.evaluate(async (editable) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    const row = editable.closest('.composer-row');
    const measurer = row?.parentElement?.querySelector('.composer-measurer');
    if (!row || !measurer) throw new Error('Missing composer layout');
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const lines = new Set<number>();
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0) lines.add(Math.round(rect.top));
      }
    }
    return {
      multiline: row.classList.contains('multiline'),
      lines: lines.size,
      editorFontSize: getComputedStyle(editable).fontSize,
      measuredFontSize: getComputedStyle(measurer).fontSize,
    };
  });
}

for (const richTextComposer of [false, true]) {
  test(`touch composer moves controls when text wraps in ${richTextComposer ? 'rich' : 'plain'} mode`, async ({
    page,
    app,
    installRoomCore,
    isMobile,
  }) => {
    await page.addInitScript((rich) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: rich }));
    }, richTextComposer);
    if (!isMobile) await page.setViewportSize({ width: 1900, height: 900 });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await page.evaluate(async (mobile) => {
      await document.fonts.ready;
      const row = document.querySelector<HTMLElement>('.composer-row');
      if (!row) throw new Error('Missing composer');
      if (!mobile) row.style.width = '1229px';
    }, isMobile);

    const text = isMobile
      ? "yo why'd you close my #617? is there an unpublished solution"
      : "yo why'd you close my #617? is there an unpublished solution or did you not like my repro steps? it's a real issue i had to use my phone to sync the theme to the";
    const start = isMobile ? 0 : 125;
    await app.composer.fill(text.slice(0, start));
    let moved = false;
    for (const char of text.slice(start)) {
      await page.keyboard.type(char);
      const layout = await measure(app.composer);
      expect(
        layout.lines > 1 && !layout.multiline,
        `Text wrapped before controls moved: ${await app.composer.textContent()}`
      ).toBe(false);
      moved ||= layout.multiline;
    }
    expect(moved).toBe(true);
    const layout = await measure(app.composer);
    expect(layout.measuredFontSize).toBe(layout.editorFontSize);

    for (let index = start; index < text.length; index += 1) {
      await app.composer.press('Backspace');
      const layout = await measure(app.composer);
      expect(layout.lines > 1 && !layout.multiline).toBe(false);
    }
    await expect(page.locator('.composer-row')).not.toHaveClass(/multiline/);
  });
}
