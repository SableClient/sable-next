// Scripted transport, because the sizes under test come from the event's own
// dimensions and a real room cannot be made to carry a 200x6000 picture on cue.

import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

const NARROW = { width: 390, height: 800 };
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
  await expect(timeline.image.first().locator('img')).toBeVisible();

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
  await expect(timeline.image.first().locator('img')).toBeVisible();

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
  await expect(timeline.image.first().locator('img')).toBeVisible();

  const box = await mediaBox(page);
  expect(box.width / box.height).toBeCloseTo(600 / 900, 2);
  expect(box.height).toBeLessThanOrEqual(MEDIA_MAX_PX + 1);
  expect(box.sideways).toBe(0);
});

test('a gallery in a bubble keeps its columns on mobile', async ({
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
          body: 'one',
          source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
          mime: 'image/png',
          width: 800,
          height: 600,
        },
        {
          kind: 'image',
          body: 'two',
          source: JSON.stringify({ Plain: 'mxc://example.test/wide-history-image' }),
          mime: 'image/png',
          width: 1000,
          height: 400,
        },
      ],
    },
  });
  await expect(timeline.image.first().locator('img')).toBeVisible();

  const box = await mediaBox(page, '.gallery');
  expect(box.width).toBeGreaterThan(MEDIA_MIN_PX);
  expect(box.width).toBeLessThanOrEqual(box.row);
  expect(box.sideways).toBe(0);
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
          body: 'one',
          source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
          mime: 'image/png',
          width: 800,
          height: 600,
          blurhash: null,
          thumbnail: null,
        },
        {
          kind: 'file',
          body: 'report.pdf',
          source: JSON.stringify({ Plain: 'mxc://example.test/report.pdf' }),
          mime: 'application/pdf',
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
  await expect(timeline.image.first().locator('img')).toBeVisible();

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
  await expect(timeline.image.first().locator('img')).toBeVisible();
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
