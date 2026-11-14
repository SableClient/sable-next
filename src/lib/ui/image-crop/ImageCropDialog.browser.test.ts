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

afterEach(() => {
  cropRequest.settle(null);
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
  await page.getByRole('button', { name: 'Rotate' }).click();
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
  const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'cat.gif', {
    type: 'image/gif',
  });
  expect(await requestCrop(gif, 'avatar')).toBe(gif);
  expect(cropRequest.current).toBeNull();
});
