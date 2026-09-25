import { expect, test, SIGNED_OUT } from './fixtures/test';
import en from '../../src/locales/en.json' with { type: 'json' };

test.use({
  storageState: SIGNED_OUT,
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('mobile emote autocomplete keeps the editor focused and keyboard spacing stable', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - 300 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '300px');
  await app.composer.fill(':smi');
  const option = page.getByRole('option').last();
  await expect(option).toBeVisible();
  const count = await page.getByRole('option').count();
  for (let index = 1; index < count; index++) await app.composer.press('ArrowDown');
  await app.composer.evaluate((node) => {
    node.addEventListener('blur', () => {
      node.setAttribute('data-blurred', 'true');
    });
  });
  await option.tap();
  await expect(app.composer).not.toHaveText(':smi');
  await expect(app.composer).toBeFocused();
  await expect(app.composer).not.toHaveAttribute('data-blurred', 'true');
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '300px');
  const bottom = await page
    .locator('.composer')
    .evaluate((node) => node.getBoundingClientRect().bottom);
  const visibleBottom = await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    return viewport.height;
  });
  expect(bottom).toBeLessThanOrEqual(visibleBottom);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});

// The panel is capped against the visible viewport, not `dvh`: the keyboard
// shrinks the visual viewport and leaves `dvh` alone, so `30dvh` was half the
// screen exactly when the reader was typing.
test('mobile autocomplete leaves the timeline most of the screen under the keyboard', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - 336 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '336px');
  await app.composer.fill(':smi');
  await expect(page.getByRole('option').first()).toBeVisible();

  const share = await page.evaluate(() => {
    const panel = document.querySelector('.autocomplete');
    const visible = window.visualViewport?.height;
    if (!panel || !visible) throw new Error('missing panel');
    return panel.getBoundingClientRect().height / visible;
  });
  expect(share).toBeLessThanOrEqual(0.34);
});

// The fixtures carry no long names, so the row that has to ellipsize is written
// in. An `auto` grid track sizes to max-content, and `overflow-y: auto` computes
// `overflow-x` to `auto` — together they made the list pan sideways by 408px.
test('mobile autocomplete truncates a long suggestion instead of scrolling sideways', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await app.composer.fill(':smi');
  await expect(page.getByRole('option').first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const list = document.querySelector('.autocomplete ul');
    const label = document.querySelector('.autocomplete .label');
    const detail = document.querySelector('.autocomplete .detail');
    if (!list || !label) throw new Error('missing suggestion');
    label.textContent = 'a_very_long_display_name_that_never_wraps_anywhere';
    if (detail) detail.textContent = '@a.very.long.username:matrix.example.test';
    return {
      sideways: list.scrollWidth - list.clientWidth,
      option: (label.closest('[role="option"]') as HTMLElement).getBoundingClientRect().width,
      list: list.getBoundingClientRect().width,
      overflowX: getComputedStyle(list).overflowX,
    };
  });

  expect(measured.sideways).toBe(0);
  expect(measured.option).toBeLessThanOrEqual(measured.list);
  expect(['auto', 'scroll']).not.toContain(measured.overflowX);
});

// Android is the other way round: the native insets shrink the WebView, so
// `dvh` already excludes the keyboard and subtracting it again left one row.
test('mobile autocomplete does not subtract the keyboard twice on android', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.setViewportSize({ width: 390, height: 508 });
  await page.evaluate(() => {
    document.documentElement.dataset.tauriOs = 'android';
    document.documentElement.style.setProperty('--keyboard-height', '336px');
  });
  await app.composer.fill(':smi');
  await expect(page.getByRole('option').first()).toBeVisible();

  const share = await page.evaluate(() => {
    const panel = document.querySelector('.autocomplete');
    if (!panel) throw new Error('missing panel');
    return panel.getBoundingClientRect().height / window.innerHeight;
  });
  expect(share).toBeGreaterThan(0.25);
  expect(share).toBeLessThanOrEqual(0.34);
});

test('mobile emote sheet keeps its grid above the keyboard', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('missing visual viewport');
    Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - 336 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveCSS('--keyboard-height', '336px');
  await page.getByRole('button', { name: en.composer.emotesAndStickers }).tap();
  const grid = page.locator('.board.sheet .grid').first();
  await expect(grid).toBeVisible();

  const measured = await page.evaluate(() => {
    const board = document.querySelector('.board.sheet');
    const firstGrid = document.querySelector('.board.sheet .grid');
    if (!board || !firstGrid || !window.visualViewport) throw new Error('missing board');
    return {
      board: board.getBoundingClientRect().bottom,
      grid: firstGrid.getBoundingClientRect().top,
      visible: window.visualViewport.height,
    };
  });
  expect(measured.board).toBeLessThanOrEqual(measured.visible + 1);
  expect(measured.grid).toBeLessThan(measured.visible - 48);
});
