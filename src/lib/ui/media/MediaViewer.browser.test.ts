import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('#lib/platform/system-bars.js', () => ({ setSystemBarsHidden: vi.fn() }));

import { core } from '#lib/core/__mocks__/context.js';
import { imageItem } from '#lib/features/room/timeline/timeline-item-fixtures.js';

import type { MediaItem } from './media-viewer-types';
import MediaViewer from './MediaViewer.svelte';
import MediaViewerHostHarness from './MediaViewerHostHarness.test.svelte';
import { mediaViewerState } from './media-viewer-state.svelte';

const item: MediaItem = {
  kind: 'image',
  html: null,
  filename: 'shot.png',
  caption: null,
  source: 'mxc://example.test/history-image',
  external_url: null,
  mime: 'image/png',
  width: 800,
  height: 600,
  size: null,
  blurhash: null,
  thumbnail: null,
  spoiler: null,
  animated: null,
  eventId: '$shot',
  sender: 'Alice',
};

async function png(): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(800, 600);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = '#3366cc';
  context.fillRect(0, 0, 800, 600);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 800 },
] as const;

beforeEach(() => {
  Object.assign(core, { fetchMedia: vi.fn(png), forgetMedia: vi.fn() });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});

const originalMediaViewerStateClose = mediaViewerState.close.bind(mediaViewerState);

afterEach(async () => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.clientDecorations;
  document.documentElement.style.removeProperty('--safe-area-inset-top');
  document.documentElement.style.removeProperty('--safe-area-inset-left');
  document.documentElement.style.removeProperty('--safe-area-inset-right');
  await page.viewport(414, 800);
  mediaViewerState.close = originalMediaViewerStateClose;
  mediaViewerState.close();
});

async function openViewer(width: number, height: number, onClose = vi.fn()) {
  await page.viewport(width, height);
  mediaViewerState.items = [item];
  mediaViewerState.eventId = item.eventId;
  mediaViewerState.close = onClose;
  const screen = await render(MediaViewer);
  const viewer = screen.getByRole('dialog', { name: 'Media viewer', exact: true });
  await expect.poll(() => viewer.element().querySelector('.stage img')).not.toBeNull();
  return { screen, viewer, onClose };
}

test.each(['win32', 'linux'])(
  'Electron %s offers a working Copy image toolbar action',
  async (platform) => {
    vi.stubGlobal('sableElectron', { platform });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue(undefined);
    try {
      const { viewer } = await openViewer(1280, 800);
      await userEvent.click(viewer.getByRole('button', { name: 'Copy image', exact: true }));
      await expect.poll(() => write.mock.calls.length).toBe(1);
      const clipboardItem = write.mock.calls[0][0][0];
      expect((await clipboardItem.getType('image/png')).type).toBe('image/png');
      expect(viewer.getByRole('button', { name: 'Share', exact: true }).elements()).toHaveLength(0);
    } finally {
      write.mockRestore();
    }
  }
);

test('viewer actions clear asymmetric safe areas', async () => {
  const { viewer } = await openViewer(375, 560);
  for (const width of [375, 1280]) {
    await page.viewport(width, 560);
    for (const [left, right] of [
      [0, 48],
      [48, 0],
    ]) {
      document.documentElement.style.setProperty('--safe-area-inset-top', '32px');
      document.documentElement.style.setProperty('--safe-area-inset-left', `${left}px`);
      document.documentElement.style.setProperty('--safe-area-inset-right', `${right}px`);
      const node = viewer.element().querySelector('.actions');
      if (!node) throw new Error('.actions is not rendered');
      const actions = node.getBoundingClientRect();
      expect(actions.left).toBeGreaterThanOrEqual(left);
      expect(actions.right).toBeLessThanOrEqual(width - right);
      expect(actions.top).toBeGreaterThanOrEqual(32);
    }
  }
});

for (const viewport of VIEWPORTS) {
  test(`viewer toolbar respects titlebar and safe-area offsets on ${viewport.name}`, async () => {
    const { viewer } = await openViewer(viewport.width, viewport.height);

    for (const decorations of [null, 'desktop', 'mac']) {
      for (const safeTop of [0, 24]) {
        if (decorations === null) delete document.documentElement.dataset.clientDecorations;
        else document.documentElement.dataset.clientDecorations = decorations;
        document.documentElement.style.setProperty('--safe-area-inset-top', `${String(safeTop)}px`);
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const element = viewer.element();
        const toolbar = element.querySelector('header');
        if (!toolbar) throw new Error('viewer toolbar missing');
        const rect = element.getBoundingClientRect();
        const toolbarStyle = getComputedStyle(toolbar);
        const fontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);

        expect(rect.top, `${String(decorations)} ${String(safeTop)}`).toBe(
          decorations === null ? 0 : 2 * fontSize
        );
        expect(rect.bottom).toBe(window.innerHeight);
        expect(Number.parseFloat(toolbarStyle.paddingTop)).toBe(
          Number.parseFloat(toolbarStyle.paddingBottom) + safeTop
        );
      }
    }
  });

  test(`viewer header and menu actions on ${viewport.name}`, async () => {
    const { screen, viewer, onClose } = await openViewer(viewport.width, viewport.height);
    const mobile = viewport.name === 'mobile';
    const header = viewer;
    const image = () => viewer.element().querySelector<HTMLElement>('.stage img');
    expect(viewer.element().querySelectorAll('.media-image-spoiler')).toHaveLength(0);
    const buttons = [...viewer.element().querySelectorAll('header .actions > button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Share',
      'Download image',
      'More actions',
      'Close',
    ]);
    const zoomIn = header.getByRole('button', { name: 'Zoom in', exact: true });
    if (mobile) {
      expect(zoomIn.elements().filter((node: Element) => node.checkVisibility())).toHaveLength(0);
    } else {
      await userEvent.click(zoomIn);
      await expect.element(header.getByRole('button', { name: '120%', exact: true })).toBeVisible();
    }

    const more = header.getByRole('button', { name: 'More actions' });
    const menu = () => screen.getByRole('menu');
    const pick = async (label: string) => {
      await userEvent.click(more);
      await userEvent.click(menu().getByText(label, { exact: true }));
      await expect.poll(() => menu().elements().length).toBe(0);
    };
    await userEvent.click(more);
    await expect.element(menu().getByText('Copy image', { exact: true })).toBeVisible();
    await expect.element(menu().getByText('Hide image', { exact: true })).toBeVisible();
    await userEvent.click(menu().getByText('Rotate image', { exact: true }));
    await expect.poll(() => menu().elements().length).toBe(0);
    expect(image()?.getAttribute('style')).toMatch(/rotate\(90deg\)/);

    await pick('Pixelate');
    expect(image()?.className).toMatch(/pixelated/);

    await userEvent.click(more);
    expect(menu().element().querySelector('[aria-checked="true"]')?.textContent.trim()).toBe(
      'Pixelate'
    );
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => menu().elements().length).toBe(0);
    await expect.element(viewer).toBeVisible();
    await expect.element(more).toHaveFocus();
    await pick('Pixelate');
    expect(image()?.className).not.toMatch(/pixelated/);
    await pick('Reset view');
    expect(image()?.getAttribute('style')).toMatch(/rotate\(0deg\)/);
    await userEvent.click(header.getByRole('button', { name: 'Close', exact: true }));
    expect(onClose).toHaveBeenCalled();
  });
}

function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointermove',
  target: Element,
  init: PointerEventInit
): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, ...init })
  );
}

test('viewer backdrop clicks on desktop', async () => {
  const { viewer, onClose } = await openViewer(1280, 900);
  const stage = viewer.element().querySelector('.stage');
  if (!stage) throw new Error('the viewer stage is missing');
  const image = () => {
    const node = viewer.element().querySelector<HTMLElement>('.stage img');
    if (!node) throw new Error('the viewer image is missing');
    return node;
  };
  expect(viewer.element().querySelectorAll('footer')).toHaveLength(0);
  expect(viewer.element().querySelector('.heading')?.textContent).toContain('shot.png');
  const alpha = Number(
    getComputedStyle(viewer.element()).backgroundColor.match(/\/\s*([\d.]+)/)?.[1] ?? 1
  );
  expect(alpha).toBe(0.9);

  await userEvent.click(image());
  await userEvent.click(viewer.getByRole('button', { name: 'Zoom in', exact: true }));
  expect(image().getAttribute('style')).toMatch(/scale\(1\.2\)/);
  expect(onClose).not.toHaveBeenCalled();

  const mouse = { pointerId: 1, pointerType: 'mouse' };
  pointer('pointerdown', image(), { ...mouse, clientX: 400, clientY: 300 });
  pointer('pointerup', stage, { ...mouse, clientX: 30, clientY: 30 });
  await expect.element(viewer).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();

  pointer('pointerdown', stage, { ...mouse, clientX: 30, clientY: 30 });
  pointer('pointermove', stage, { ...mouse, clientX: 100, clientY: 30 });
  pointer('pointermove', stage, { ...mouse, clientX: 30, clientY: 30 });
  pointer('pointerup', stage, { ...mouse, clientX: 30, clientY: 30 });
  await expect.element(viewer).toBeVisible();

  pointer('pointerdown', stage, { pointerId: 5, pointerType: 'touch', clientX: 30, clientY: 100 });
  pointer('pointerup', stage, { pointerId: 5, pointerType: 'touch', clientX: 30, clientY: 100 });
  await expect.element(viewer).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.click(stage, { position: { x: 30, y: 30 } });
  await expect.poll(() => onClose.mock.calls.length).toBe(1);
});

test('viewer backdrop clicks on mobile', async () => {
  const { viewer, onClose } = await openViewer(390, 800);
  expect(viewer.element().querySelectorAll('footer')).toHaveLength(0);
  const alpha = Number(
    getComputedStyle(viewer.element()).backgroundColor.match(/\/\s*([\d.]+)/)?.[1] ?? 1
  );
  expect(alpha).toBe(1);

  const image = viewer.element().querySelector<HTMLElement>('.stage img');
  if (!image) throw new Error('the viewer image is missing');
  const box = image.getBoundingClientRect();
  const touch = {
    pointerId: 7,
    pointerType: 'touch',
    clientX: box.x + 20,
    clientY: box.y + box.height / 2,
  };
  pointer('pointerdown', image, touch);
  pointer('pointerup', image, touch);
  await expect
    .poll(() => viewer.element().querySelector('header')?.className, { timeout: 3_000 })
    .toMatch(/chrome-hidden/);
  await expect.element(viewer).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
});

test('viewer refits a fitted image when the stage resizes', async () => {
  const { viewer } = await openViewer(1280, 900);
  const scale = () =>
    viewer
      .element()
      .querySelector<HTMLElement>('.stage img')
      ?.style.transform.match(/scale\(([\d.]+)\)/)?.[1];
  await expect.poll(scale).toBe('1');

  await page.viewport(390, 800);
  await expect.poll(() => Number(scale())).toBeLessThan(1);
});

test('timeline media opens after a standalone image closed from the backdrop', async () => {
  await page.viewport(1280, 900);
  const screen = await render(MediaViewerHostHarness);
  mediaViewerState.openStandalone('mxc://example.test/avatar', 'Alice');
  await expect.poll(() => document.querySelector('.stage img')).not.toBeNull();
  const stage = document.querySelector('.stage');
  if (!stage) throw new Error('the viewer stage is missing');
  await userEvent.click(stage, { position: { x: 30, y: 600 } });
  await expect.poll(() => mediaViewerState.eventId).toBeNull();

  mediaViewerState.open('$item', () => [imageItem()]);
  expect(mediaViewerState.items.map((media) => media.eventId)).toEqual(['$item']);
  await expect
    .element(screen.getByRole('dialog', { name: 'Media viewer', exact: true }))
    .toBeVisible();
});
