import type { Locator } from '@playwright/test';

import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('formatting uses the footer space on desktop and mobile', async ({
  page,
  app,
  installRoomCore,
  isMobile,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
  });
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await app.composer.fill('draft words');
  await app.composer.press('ControlOrMeta+a');
  const before = await page.locator('.composer').boundingBox();

  await page.getByRole('button', { name: 'Formatting', exact: true }).click();
  const formatting = await page.locator('.formatting').boundingBox();
  const controls = await page.locator('.composer-after').boundingBox();
  const field = await page.locator('.composer-field').boundingBox();
  const after = await page.locator('.composer').boundingBox();
  if (!before || !formatting || !controls || !field || !after)
    throw new Error('Missing composer layout');

  expect(formatting.y).toBeGreaterThanOrEqual(field.y + field.height);
  expect(Math.abs(formatting.y - controls.y)).toBeLessThanOrEqual(1);
  expect(after.height).toBe(before.height);

  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(app.composer.locator('strong')).toHaveText('draft words');
  await expect(app.composer).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('composer-formatting.png') });

  await page.getByRole('button', { name: 'Underline', exact: true }).click();
  await expect(app.composer.locator('u')).toHaveText('draft words');
  await expect(app.composer).toBeFocused();
  const composer = await page.locator('.composer').boundingBox();
  if (!composer) throw new Error('Missing composer layout');
  expect(formatting.x).toBeGreaterThanOrEqual(composer.x);
  expect(formatting.x + formatting.width).toBeLessThanOrEqual(composer.x + composer.width);

  await page.getByRole('button', { name: 'Formatting', exact: true }).click();
  await expect(page.locator('.formatting')).toHaveCount(0);
});

for (const width of [320, 520]) {
  test(`formatting scrolls in a narrow ${width}px composer`, async ({
    page,
    app,
    installRoomCore,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    await page.addInitScript(() => {
      localStorage.setItem(
        'sable-preferences',
        JSON.stringify({
          richTextComposer: true,
          theme: 'dark',
          composerGifButton: false,
          composerStickerButton: false,
        })
      );
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await page.getByRole('button', { name: 'Formatting', exact: true }).click();
    const rail = page.locator('.formatting');
    const strip = await rail.boundingBox();
    const field = await page.locator('.composer-field').boundingBox();
    const plus = await page.locator('.composer-before').boundingBox();
    const actions = await page.locator('.composer-after').boundingBox();
    if (!strip || !field || !plus || !actions) throw new Error('Missing composer controls');
    expect(strip.y).toBeGreaterThanOrEqual(field.y + field.height);
    if (width < 400) {
      expect(strip.y + strip.height).toBeLessThanOrEqual(actions.y);
    } else {
      expect(strip.x).toBeGreaterThanOrEqual(plus.x + plus.width);
      expect(strip.x + strip.width).toBeLessThanOrEqual(actions.x);
      expect(Math.abs(strip.y - actions.y)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath('formatting-collapsed.png') });
    expect(await rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await rail.dispatchEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true });
    expect(await rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Highlight colour', exact: true }).focus();
    await expect(
      page.getByRole('button', { name: 'Highlight colour', exact: true })
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('formatting-scrolled.png') });
  });
}

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
