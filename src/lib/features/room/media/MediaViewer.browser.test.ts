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

import type { MediaItem } from './media-viewer-types';
import MediaViewer from './MediaViewer.svelte';

const item: MediaItem = {
  kind: 'image',
  html: null,
  filename: 'shot.png',
  caption: null,
  source: 'mxc://example.test/history-image',
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

afterEach(async () => {
  delete document.documentElement.dataset.clientDecorations;
  document.documentElement.style.removeProperty('--safe-area-inset-top');
  await page.viewport(414, 800);
});

async function openViewer(width: number, height: number, onClose = vi.fn()) {
  await page.viewport(width, height);
  const screen = await render(MediaViewer, {
    items: [item],
    selectedEventId: item.eventId,
    onClose,
  });
  const viewer = screen.getByRole('dialog', { name: 'Media viewer', exact: true });
  await expect.poll(() => viewer.element().querySelector('.stage img')).not.toBeNull();
  return { screen, viewer, onClose };
}

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
