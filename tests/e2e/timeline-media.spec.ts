// Scripted transport, because the sizes under test come from the event's own
// dimensions and a real room cannot be made to carry a 200x6000 picture on cue.

import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const NARROW = { width: 390, height: 800 };
const MEDIA_LOADED = { timeout: 15_000 };
const MEDIA_MAX_PX = 400;
const MEDIA_MIN_PX = 128;

function picture(width: number, height: number) {
  return {
    ...timelineItem('media-probe', 'probe'),
    content: {
      kind: 'image',
      filename: 'shot.png',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      mime: 'image/png',
      width,
      height,
      size: null,
      blurhash: null,
      spoiler: null,
    },
  };
}

function undecodablePicture() {
  const item = picture(800, 600);
  return {
    ...item,
    content: {
      ...item.content,
      source: JSON.stringify({ Plain: 'mxc://example.test/undecodable-shot' }),
    },
  };
}

for (const mobile of [false, true]) {
  test(`viewer toolbar respects titlebar and safe-area offsets${mobile ? ' on mobile' : ''}`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await page.setViewportSize(mobile ? NARROW : { width: 1280, height: 900 });
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    await core.setTimelineItemById(await core.subscription(), 'general-19', picture(800, 600));
    await timeline.container.getByRole('button', { name: 'Open shot.png' }).click();

    const viewer = page.getByRole('dialog', { name: 'Media viewer', exact: true });
    await expect(viewer.locator('.stage img')).toBeVisible(MEDIA_LOADED);

    for (const decorations of [null, 'desktop', 'mac']) {
      for (const safeTop of [0, 24]) {
        await page.evaluate(
          ({ decorations, safeTop }) => {
            const root = document.documentElement;
            if (decorations === null) delete root.dataset.clientDecorations;
            else root.dataset.clientDecorations = decorations;
            root.style.setProperty('--safe-area-inset-top', `${safeTop}px`);
          },
          { decorations, safeTop }
        );

        const layout = await viewer.evaluate((element) => {
          const toolbar = element.querySelector('header');
          if (!toolbar) throw new Error('viewer toolbar missing');
          const rect = element.getBoundingClientRect();
          const toolbarStyle = getComputedStyle(toolbar);
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            top: rect.top,
            bottom: rect.bottom,
            paddingTop: Number.parseFloat(toolbarStyle.paddingTop),
            paddingBottom: Number.parseFloat(toolbarStyle.paddingBottom),
            fontSize: Number.parseFloat(rootStyle.fontSize),
            viewportHeight: window.innerHeight,
          };
        });

        expect(layout.top).toBe(decorations === null ? 0 : 2 * layout.fontSize);
        expect(layout.bottom).toBe(layout.viewportHeight);
        expect(layout.paddingTop).toBe(layout.paddingBottom + safeTop);
      }
    }
  });

  test(`viewer backdrop clicks${mobile ? ' on mobile' : ''}`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }, testInfo) => {
    await installRoomCore('ready');
    await page.setViewportSize(mobile ? NARROW : { width: 1280, height: 900 });
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    const item = picture(800, 600);
    await core.setTimelineItemById(await core.subscription(), 'general-19', {
      ...item,
      content: {
        ...item.content,
        source: JSON.stringify({ Plain: 'mxc://example.test/spoiler-preview-backdrop' }),
      },
    });
    const open = timeline.container.getByRole('button', { name: 'Open shot.png' });
    await open.click();

    const viewer = page.getByRole('dialog', { name: 'Media viewer', exact: true });
    const image = viewer.locator('.stage img');
    const stage = viewer.locator('.stage');
    await expect(image).toBeVisible(MEDIA_LOADED);
    await expect(image).toHaveCSS('opacity', '1');
    await expect(viewer.locator('footer')).toHaveCount(0);
    await expect(viewer.locator('.heading')).toContainText('shot.png');
    const alpha = await viewer.evaluate((element) =>
      Number(getComputedStyle(element).backgroundColor.match(/\/\s*([\d.]+)/)?.[1] ?? 1)
    );
    expect(alpha).toBe(mobile ? 1 : 0.9);
    await page.screenshot({ path: testInfo.outputPath('viewer-backdrop.png') });

    if (mobile) {
      const bounds = await stage.boundingBox();
      if (!bounds) throw new Error('viewer stage missing');
      await page.touchscreen.tap(bounds.x + 20, bounds.y + bounds.height / 2);
      await expect(viewer.locator('header')).toHaveClass(/chrome-hidden/);
      await expect(viewer).toBeVisible();
    } else {
      await image.click();
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect(image).toHaveAttribute('style', /scale\(1\.2\)/);

      await image.hover();
      await page.mouse.down();
      await stage.hover({ position: { x: 30, y: 30 } });
      await page.mouse.up();
      await expect(viewer).toBeVisible();

      await stage.hover({ position: { x: 30, y: 30 } });
      await page.mouse.down();
      await stage.hover({ position: { x: 100, y: 30 } });
      await stage.hover({ position: { x: 30, y: 30 } });
      await page.mouse.up();
      await expect(viewer).toBeVisible();
      await stage.click({ position: { x: 30, y: 30 }, button: 'right' });
      await expect(viewer).toBeVisible();

      await stage.dispatchEvent('pointerdown', {
        pointerId: 5,
        pointerType: 'touch',
        button: 0,
        clientX: 30,
        clientY: 100,
      });
      await stage.dispatchEvent('pointerup', { pointerId: 5, pointerType: 'touch' });
      await expect(viewer).toBeVisible();

      await stage.click({ position: { x: 30, y: 30 } });
      await expect(viewer).toHaveCount(0);
      await expect(open).toBeFocused();
    }
  });

  test(`viewer header and menu actions${mobile ? ' on mobile' : ''}`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installRoomCore('ready');
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true });
    });
    await page.setViewportSize(mobile ? NARROW : { width: 1280, height: 900 });
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    await core.setTimelineItemById(await core.subscription(), 'general-19', picture(800, 600));
    await timeline.container.getByRole('button', { name: 'Open shot.png' }).click();

    const viewer = page.getByRole('dialog', { name: 'Media viewer', exact: true });
    const header = viewer.locator('header');
    const image = viewer.locator('.stage img');
    await expect(image).toBeVisible(MEDIA_LOADED);
    await expect(viewer.locator('.media-image-spoiler')).toHaveCount(0);
    const buttons = header.locator('.actions > button');
    await expect(buttons).toHaveCount(4);
    await expect(buttons.nth(0)).toHaveAccessibleName('Share');
    await expect(buttons.nth(1)).toHaveAccessibleName('Download image');
    await expect(buttons.nth(2)).toHaveAccessibleName('More actions');
    await expect(buttons.nth(3)).toHaveAccessibleName('Close');
    const zoomIn = header.getByRole('button', { name: 'Zoom in', exact: true });
    if (mobile) {
      await expect(zoomIn).toBeHidden();
    } else {
      await expect(zoomIn).toBeVisible();
      await zoomIn.click();
      await expect(header.getByRole('button', { name: '120%', exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('viewer-header.png') });

    const more = header.getByRole('button', { name: 'More actions' });
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByText('Copy image', { exact: true })).toBeVisible();
    await expect(menu.getByText('Hide image', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('viewer-more.png') });
    await menu.getByText('Rotate image', { exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(image).toHaveAttribute('style', /rotate\(90deg\)/);

    await more.click();
    await menu.getByText('Pixelate', { exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(image).toHaveClass(/pixelated/);

    await more.click();
    await expect(menu.locator('[aria-checked="true"]')).toHaveText('Pixelate');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await expect(more).toBeFocused();
    await more.click();
    await menu.getByText('Pixelate', { exact: true }).click();
    await expect(image).not.toHaveClass(/pixelated/);
    await more.click();
    await menu.getByText('Reset view', { exact: true }).click();
    await expect(image).toHaveAttribute('style', /rotate\(0deg\)/);
    await header.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test(`image spoilers blur and reveal without opening the viewer${mobile ? ' on mobile' : ''}`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }, testInfo) => {
    await installRoomCore('ready');
    await page.setViewportSize(mobile ? NARROW : { width: 1280, height: 900 });
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    const photo = picture(800, 600);
    await core.setTimelineItemById(await core.subscription(), 'general-19', {
      ...photo,
      content: {
        ...photo.content,
        source: JSON.stringify({ Plain: 'mxc://example.test/spoiler-preview' }),
        spoiler: 'Final scene',
      },
    });
    const media = timeline.container.locator('.spoilerable-media');
    await expect(media.locator('img')).toBeVisible(MEDIA_LOADED);
    await expect(media.locator('.media-image-visual')).toHaveCSS('filter', 'blur(44px)');
    const hiddenBox = await media.boundingBox();
    await page.screenshot({ path: testInfo.outputPath('spoiler-hidden.png') });

    const reveal = media.getByRole('button', { name: 'Reveal shot.png' });
    await reveal.focus();
    await reveal.press('Enter');
    await expect(media).not.toHaveClass(/spoilered/);
    await expect(page.getByRole('dialog', { name: 'Media viewer' })).toHaveCount(0);
    expect(await media.boundingBox()).toEqual(hiddenBox);

    await media.hover();
    await page.screenshot({ path: testInfo.outputPath('spoiler-revealed.png') });
    await media.getByRole('button', { name: 'Hide shot.png' }).click();
    await expect(media).toHaveClass(/spoilered/);
    await media.getByRole('button', { name: 'Reveal shot.png' }).click();
    await media.getByRole('button', { name: 'Open shot.png' }).click();
    await expect(page.getByRole('dialog', { name: 'Media viewer' })).toBeVisible();
    const viewer = page.getByRole('dialog', { name: 'Media viewer' });
    await expect(viewer.locator('.stage img')).toBeVisible(MEDIA_LOADED);
    await expect(viewer.locator('.stage img')).toHaveCSS('filter', 'blur(44px)');
    await page.screenshot({ path: testInfo.outputPath('viewer-spoiler-hidden.png') });
    await viewer.getByRole('button', { name: 'Reveal shot.png' }).click();
    await expect(viewer.getByRole('img', { name: 'shot.png', exact: true })).toHaveCSS(
      'filter',
      'none'
    );
    await expect(viewer.locator('.media-image-spoiler')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('viewer-spoiler-revealed.png') });
    await viewer.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Hide image', exact: true }).click();
    await expect(viewer.locator('.stage img')).toHaveCSS('filter', 'blur(44px)');
    await expect(viewer.getByRole('button', { name: 'Reveal shot.png' })).toBeVisible();
  });

  test(`inline and link-preview images can be hidden${mobile ? ' on mobile' : ''}`, async ({
    page,
    app,
    timeline,
    core,
    installRoomCore,
  }, testInfo) => {
    await installRoomCore('ready');
    await page.setViewportSize(mobile ? NARROW : { width: 1280, height: 900 });
    await app.openRooms();
    await app.openRoomFromList('General');
    await timeline.expectRevealed();
    const message = timelineItem('inline-probe', 'Photo and link');
    const html =
      '<p><img src="mxc://example.test/spoiler-preview-inline" alt="Landscape"></p><p><a href="https://example.org/landscape">Landscape link</a></p>';
    await core.setTimelineItemById(await core.subscription(), 'general-19', {
      ...message,
      content: { ...message.content, html },
      bundled_link_previews: [
        {
          url: 'https://example.org/landscape',
          title: 'Landscape',
          description: null,
          site_name: 'Example',
          image: 'mxc://example.test/spoiler-preview-link',
          image_width: 800,
          image_height: 600,
          image_mime: 'image/png',
        },
      ],
    });
    for (const selector of ['.inline-image', '.link-preview-image']) {
      const media = timeline.container.locator(selector);
      await expect(media.locator('img')).toBeVisible(MEDIA_LOADED);
      await media.hover();
      await media.getByRole('button', { name: 'Hide image' }).click();
      await expect(media).toHaveClass(/spoilered/);
      await expect(media.getByRole('button', { name: 'Reveal image' })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('inline-link-hidden.png') });
    await expect(page.getByRole('dialog', { name: 'Media viewer' })).toHaveCount(0);
    for (const selector of ['.inline-image', '.link-preview-image']) {
      const media = timeline.container.locator(selector);
      await media.getByRole('button', { name: 'Reveal image' }).click();
      await expect(media).not.toHaveClass(/spoilered/);
    }
    await page.screenshot({ path: testInfo.outputPath('inline-link-revealed.png') });
  });
}

function mediaBox(page: Page, selector = '.media-image') {
  return page.evaluate((target: string) => {
    const node = document.querySelector(`.timeline-viewport ${target}`);
    const row = node?.closest('.item');
    const viewport = document.querySelector('.timeline-viewport .viewport');
    if (!node || !row || !viewport) throw new Error('missing media row');
    const box = node.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      row: row.getBoundingClientRect().width,
      sideways: viewport.scrollWidth - viewport.clientWidth,
    };
  }, selector);
}

async function bubbleLayout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ layout: 'bubble' }));
  });
}

test('a captionless picture fills its bubble on mobile rather than collapsing', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await bubbleLayout(page);
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', picture(1000, 400));
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const box = await mediaBox(page);
  expect(box.width).toBeGreaterThan(MEDIA_MIN_PX);
  expect(box.width).toBeLessThanOrEqual(box.row);
  expect(box.sideways).toBe(0);
});

test('a very tall picture keeps a usable width and a bounded height on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', picture(200, 6000));
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const box = await mediaBox(page);
  expect(box.width).toBeCloseTo(MEDIA_MIN_PX, 0);
  expect(box.height).toBeLessThanOrEqual(MEDIA_MAX_PX + 1);
  expect(box.sideways).toBe(0);
});

test('an ordinary portrait keeps its shape on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', picture(600, 900));
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const box = await mediaBox(page);
  expect(box.width / box.height).toBeCloseTo(600 / 900, 2);
  expect(box.height).toBeLessThanOrEqual(MEDIA_MAX_PX + 1);
  expect(box.sideways).toBe(0);
});

test('a gallery in a bubble stacks its items on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await bubbleLayout(page);
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', {
    ...picture(800, 600),
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: [
        {
          kind: 'image',
          filename: 'one',
          caption: null,
          source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
          mime: 'image/png',
          width: 800,
          height: 600,
          size: null,
          blurhash: null,
          thumbnail: null,
          spoiler: null,
        },
        {
          kind: 'image',
          filename: 'two',
          caption: null,
          source: JSON.stringify({ Plain: 'mxc://example.test/wide-history-image' }),
          mime: 'image/png',
          width: 1000,
          height: 400,
          size: null,
          blurhash: null,
          thumbnail: null,
          spoiler: null,
        },
      ],
    },
  });
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const box = await mediaBox(page, '.gallery');
  expect(box.width).toBeGreaterThan(MEDIA_MIN_PX);
  expect(box.width).toBeLessThanOrEqual(box.row);
  expect(box.sideways).toBe(0);

  const cells = await page
    .locator('.timeline-viewport .gallery .cell')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
  expect(cells).toHaveLength(2);
  expect(cells[1]).toBeCloseTo(cells[0] ?? 0, 0);
});

test('a gallery keeps two columns on desktop', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', {
    ...picture(800, 600),
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: ['one', 'two'].map((filename) => ({
        kind: 'image',
        filename,
        caption: null,
        source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
        mime: 'image/png',
        width: 800,
        height: 600,
        size: null,
        blurhash: null,
        thumbnail: null,
        spoiler: null,
      })),
    },
  });
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const cells = await page
    .locator('.timeline-viewport .gallery .cell')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
  expect(cells).toHaveLength(2);
  expect(cells[1]).toBeCloseTo(cells[0] ?? 0, 0);
});

test('a pdf in a gallery opens in the viewer', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', {
    ...picture(800, 600),
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: [
        {
          kind: 'image',
          filename: 'one',
          caption: null,
          source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
          mime: 'image/png',
          width: 800,
          height: 600,
          size: null,
          blurhash: null,
          thumbnail: null,
          spoiler: null,
        },
        {
          kind: 'file',
          filename: 'report.pdf',
          caption: null,
          source: JSON.stringify({ Plain: 'mxc://example.test/report.pdf' }),
          mime: 'application/pdf',
          size: null,
        },
      ],
    },
  });

  await page.getByRole('button', { name: 'Open report.pdf' }).click();

  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('.pdf-canvas-frame')).toBeVisible();
  await expect(viewer.locator('.pdf-error')).toHaveCount(0);
});

test('a video in a bubble fills its bubble on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await bubbleLayout(page);
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', {
    ...picture(1920, 1080),
    content: {
      kind: 'video',
      filename: 'clip.mp4',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      mime: 'video/mp4',
      width: 1920,
      height: 1080,
      blurhash: null,
      spoiler: null,
    },
  });
  await expect(page.locator('.timeline-viewport .media-frame')).toBeVisible();

  const box = await mediaBox(page, '.media-frame');
  expect(box.width).toBeGreaterThan(MEDIA_MIN_PX);
  expect(box.width).toBeLessThanOrEqual(box.row);
  expect(box.sideways).toBe(0);
});

test('a picture is capped and its bubble hugs it once the column is wider than the cap', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await bubbleLayout(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', picture(1600, 900));
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);

  const box = await mediaBox(page);
  const bubble = await mediaBox(page, '.content-bubble');
  expect(box.width).toBeCloseTo(MEDIA_MAX_PX, 0);
  expect(bubble.width).toBeLessThan(box.row);
  expect(box.sideways).toBe(0);
});

function portraitVideo() {
  return {
    ...timelineItem('media-probe', 'probe'),
    content: {
      kind: 'video',
      filename: 'clip.mp4',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
      mime: 'video/mp4',
      width: 600,
      height: 900,
      blurhash: null,
      spoiler: null,
    },
  };
}

test('a portrait video is bounded like a portrait picture on mobile', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize(NARROW);
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', portraitVideo());
  await expect(page.locator('.timeline-viewport .media-frame')).toBeVisible();

  const box = await mediaBox(page, '.media-frame');
  expect(box.width / box.height).toBeCloseTo(600 / 900, 2);
  expect(box.height).toBeLessThanOrEqual(MEDIA_MAX_PX + 1);
  expect(box.sideways).toBe(0);
});

// `estimateRowSize` reserves one box for both kinds.
test('a video takes the same box as the picture it shares dimensions with', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('delayed_media');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  const subscription = await core.subscription();
  await core.setTimelineItemById(subscription, 'general-19', picture(600, 900));
  await expect(timeline.image.first().locator('img')).toBeVisible(MEDIA_LOADED);
  const asPicture = await mediaBox(page, '.media-image');

  await core.setTimelineItemById(subscription, 'media-probe', portraitVideo());
  await expect(page.locator('.timeline-viewport .media-frame')).toBeVisible();
  const asVideo = await mediaBox(page, '.media-frame');

  expect(asVideo.width).toBeCloseTo(asPicture.width, 0);
  expect(asVideo.height).toBeCloseTo(asPicture.height, 0);
  expect(asVideo.sideways).toBe(0);
});

test('a picture that will not decode falls back to the original once, then stops asking', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await core.setTimelineItemById(await core.subscription(), 'general-19', undecodablePicture());
  const media = timeline.image.first();

  await expect(media).toContainText('Media unavailable');
  const fetches = await core.mediaFetches();
  expect(fetches.at(-1)).toBe('fetch_media 0x0');
  expect(fetches.filter((fetch) => fetch === 'fetch_media 0x0')).toHaveLength(1);

  await page.waitForTimeout(3_000);
  expect(await core.mediaFetches()).toEqual(fetches);
  await expect(media.locator('img')).toHaveCount(0);

  await media.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => core.commands()).toContain('forget_media');
  await expect.poll(async () => (await core.mediaFetches()).length).toBeGreaterThan(fetches.length);
});
