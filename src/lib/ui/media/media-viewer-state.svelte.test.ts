// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import type { MediaItem } from '#lib/ui/media/media-viewer-types.js';
import { mediaViewerState as viewer } from './media-viewer-state.svelte.js';
import { imageItem } from '#lib/features/room/timeline/timeline-item-fixtures.js';

afterEach(() => {
  viewer.close();
});

const avatar = {
  kind: 'image',
  filename: 'Alice',
  caption: null,
  html: null,
  source: 'mxc://example.org/alice',
  external_url: null,
  mime: null,
  width: null,
  height: null,
  size: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  animated: null,
  sender: 'Alice',
};

test('a standalone item replaces the timeline items with a fresh id each time', () => {
  viewer.openStandalone(avatar.source, avatar.filename);
  expect(viewer.eventId).toBe('standalone-1');
  expect(viewer.items.map((item) => item.eventId)).toEqual(['standalone-1']);
  viewer.openStandalone(avatar.source, avatar.filename);
  expect(viewer.eventId).toBe('standalone-2');
});

test('panel items win over the timeline until the viewer closes', () => {
  const panel = [{ ...avatar, eventId: '$panel' }] as MediaItem[];
  viewer.openPanel(panel, '$panel');
  expect(viewer.items).toEqual(panel);
  expect(viewer.eventId).toBe('$panel');
  viewer.close();
  expect(viewer.eventId).toBeNull();
  expect(viewer.panelItems).toBeNull();
  expect(viewer.items).toEqual([]);
});

test('opening timeline media drops panel and standalone items', () => {
  viewer.openStandalone(avatar.source, avatar.filename);
  viewer.open('$event', () => [imageItem()]);
  expect(viewer.eventId).toBe('$event');
  expect(viewer.standaloneItem).toBeNull();
  expect(viewer.items.map((item) => item.eventId)).toEqual(['$item']);
});

test('opens profile images at full resolution without a timeline event', () => {
  viewer.openStandalone('mxc://example.org/banner', 'Alice');
  expect(viewer.standaloneItem).toEqual({
    ...avatar,
    source: 'mxc://example.org/banner',
    eventId: viewer.eventId,
  });
  viewer.close();
  expect(viewer.items).toEqual([]);
});

test('jumping closes the viewer before calling the opener with the gallery event', async () => {
  const onJump = vi.fn(() => {
    expect(viewer.eventId).toBeNull();
  });
  viewer.openPanel(
    [{ ...avatar, eventId: '$gallery:gallery:2' }] as MediaItem[],
    '$gallery:gallery:2',
    onJump
  );
  viewer.jump('$gallery:gallery:2');
  expect(viewer.onJump).toBeUndefined();
  await vi.waitFor(() => {
    expect(onJump).toHaveBeenCalledExactlyOnceWith('$gallery');
  });
});

test('standalone media clears the previous jump action', () => {
  viewer.open('$item', () => [imageItem()], vi.fn());
  viewer.openStandalone(avatar.source, avatar.filename);
  expect(viewer.onJump).toBeUndefined();
});
