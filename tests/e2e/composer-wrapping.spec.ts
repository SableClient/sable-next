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
    const before = row?.querySelector('.composer-before');
    const after = row?.querySelector('.composer-after');
    if (!row || !before || !after) throw new Error('Missing composer layout');
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
      lines: lines.size,
      editorBottom: editable.getBoundingClientRect().bottom,
      controlsTop: Math.min(before.getBoundingClientRect().top, after.getBoundingClientRect().top),
    };
  });
}

for (const richTextComposer of [false, true]) {
  test(`composer keeps controls below the text in ${richTextComposer ? 'rich' : 'plain'} mode`, async ({
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
      if (!mobile) row.style.width = '800px';
    }, isMobile);

    const text = isMobile
      ? "yo why'd you close my #617? is there an unpublished solution"
      : "yo why'd you close my #617? is there an unpublished solution or did you not like my repro steps? it's a real issue i had to use my phone to sync the theme to the";
    const start = isMobile ? 0 : 125;
    await app.composer.fill(text.slice(0, start));
    let wrapped = false;
    for (const char of text.slice(start)) {
      await page.keyboard.type(char);
      const layout = await measure(app.composer);
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.editorBottom);
      wrapped ||= layout.lines > 1;
    }
    expect(wrapped).toBe(true);

    for (let index = start; index < text.length; index += 1) {
      await app.composer.press('Backspace');
      const layout = await measure(app.composer);
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.editorBottom);
    }
  });
}
