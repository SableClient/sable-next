import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));

import ImageCropHost from './ImageCropHost.svelte';
import { cropRequest, requestCrop } from './crop-request.svelte';

async function png(width: number, height: number): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = '#3366cc';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#cc3333';
  context.fillRect(0, 0, width / 2, height);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], 'photo.png', {
    type: 'image/png',
  });
}

async function size(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const result = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return result;
}

afterEach(async () => {
  cropRequest.settle(null);
  document.documentElement.dir = 'ltr';
  await page.viewport(414, 896);
});

test('an avatar crops to the centred square', async () => {
  await render(ImageCropHost);
  const result = requestCrop(await png(800, 400), 'avatar');
  const apply = page.getByRole('button', { name: 'Apply' });
  await expect.element(page.getByRole('dialog', { name: 'Crop picture' })).toBeVisible();
  await expect.element(apply).toBeEnabled();
  await apply.click();

  const cropped = await result;
  expect(cropped?.type).toBe('image/png');
  expect(await size(cropped as File)).toEqual({ width: 400, height: 400 });
});

test.each([
  ['an opaque HEIC', 'image/jpeg', 'image/heic', '#3366cc', 'photo.jpg'],
  ['an opaque HEIF', 'image/jpeg', 'image/heif', '#3366cc', 'photo.jpg'],
  ['a transparent HEIC', 'image/png', 'image/heic', 'transparent', 'photo.png'],
  ['an opaque GIF', 'image/png', 'image/gif', '#3366cc', 'photo.png'],
  ['an opaque BMP', 'image/png', 'image/bmp', '#3366cc', 'photo.png'],
  ['an opaque AVIF', 'image/png', 'image/avif', '#3366cc', 'photo.png'],
])('%s picture is saved as %s', async (_, type, source, fill, name) => {
  await render(ImageCropHost);
  const canvas = new OffscreenCanvas(400, 400);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = fill;
  context.fillRect(0, 0, 400, 400);
  const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'photo.img', {
    type: source,
  });
  const result = requestCrop(file, 'avatar');
  const apply = page.getByRole('button', { name: 'Apply' });
  await expect.element(apply).toBeEnabled();
  await apply.click();

  const cropped = await result;
  expect(cropped?.type).toBe(type);
  expect(cropped?.name).toBe(name);
});

test('right-to-left layouts centre the dialog', async () => {
  document.documentElement.dir = 'rtl';
  await page.viewport(1280, 900);
  await render(ImageCropHost);
  void requestCrop(await png(800, 400), 'avatar');
  const dialog = page.getByRole('dialog', { name: 'Crop picture' });
  await expect.element(dialog).toBeVisible();
  await expect
    .poll(() => {
      const { left, right } = dialog.element().getBoundingClientRect();
      return Math.abs(left + right - window.innerWidth);
    })
    .toBeLessThan(2);
});

test('dragging the image moves the crop', async () => {
  await render(ImageCropHost);
  const result = requestCrop(await png(800, 400), 'avatar');
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
  const stage = document.querySelector<HTMLElement>('.crop-stage');
  if (!stage) throw new Error('No stage');
  stage.setPointerCapture = () => {};
  const box = stage.getBoundingClientRect();
  const at = (type: string, x: number) => {
    stage.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        bubbles: true,
        clientX: box.left + x,
        clientY: box.top + box.height / 2,
      })
    );
  };
  at('pointerdown', box.width / 2);
  at('pointermove', box.width / 2 - 1000);
  at('pointerup', box.width / 2 - 1000);
  await page.getByRole('button', { name: 'Apply' }).click();

  const bitmap = await createImageBitmap((await result) as File);
  const canvas = new OffscreenCanvas(1, 1);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const [red, , blue] = canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data ?? [];
  expect({ red, blue }).toEqual({ red: 0x33, blue: 0xcc });
});

test('a turned attachment keeps the original shape, sideways', async () => {
  await render(ImageCropHost);
  const result = requestCrop(await png(800, 400), 'attachment');
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();

  expect(await size((await result) as File)).toEqual({
    width: 400,
    height: 800,
  });
});

test('a fourth turn keeps spinning forward', async () => {
  await render(ImageCropHost);
  void requestCrop(await png(800, 400), 'attachment');
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
  const rotate = page.getByRole('button', { name: 'Rotate right' });
  for (let turn = 0; turn < 4; turn += 1) await rotate.click();

  expect(document.querySelector<HTMLElement>('.crop-image')?.style.transform).toContain(
    'rotate(360deg)'
  );
});

test('a left turn from upright crops like three right turns', async () => {
  await render(ImageCropHost);
  const result = requestCrop(await png(800, 400), 'attachment');
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await page.getByRole('button', { name: 'Rotate left' }).click();

  expect(document.querySelector<HTMLElement>('.crop-image')?.style.transform).toContain(
    'rotate(-90deg)'
  );
  await page.getByRole('button', { name: 'Apply' }).click();
  expect(await size((await result) as File)).toEqual({
    width: 400,
    height: 800,
  });
});

test('cancel and use original settle without cropping', async () => {
  await render(ImageCropHost);
  const file = await png(300, 300);

  const cancelled = requestCrop(file, 'banner');
  await expect.element(page.getByRole('dialog', { name: 'Crop banner' })).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(await cancelled).toBeNull();

  const kept = requestCrop(file, 'banner');
  await page.getByRole('button', { name: 'Use original' }).click();
  expect(await kept).toBe(file);
});

test('animated images skip the cropper', async () => {
  await render(ImageCropHost);
  const animated = new URL(
    '../../../../crates/sable-model/tests/fixtures/images/animated.gif',
    import.meta.url
  );
  const gif = new File([await (await fetch(animated)).blob()], 'cat.gif', { type: 'image/gif' });
  expect(await requestCrop(gif, 'avatar')).toBe(gif);
  expect(cropRequest.current).toBeNull();
});
