import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));

import { replaceFile, type StagedFile } from '#lib/composer/composer-files.js';
import ImageCropHost from '#lib/ui/image-crop/ImageCropHost.svelte';

import ComposerAttachments from './ComposerAttachments.svelte';

async function png(width: number, height: number): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = '#3366cc';
  context.fillRect(0, 0, width, height);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], 'photo.png', {
    type: 'image/png',
  });
}

test('cropping a staged image replaces it and keeps the viewer open', async () => {
  await render(ImageCropHost);
  let files: StagedFile[] = [
    { id: 7, file: await png(800, 400), spoiler: true, metadata: 'location' },
  ];
  const onReplace = vi.fn((id: number, file: File) => {
    files = replaceFile(files, id, file);
  });
  const screen = await render(ComposerAttachments, {
    files,
    onRemove: vi.fn(),
    onToggleSpoiler: vi.fn(),
    onSetMetadata: vi.fn(),
    onReplace,
  });
  const thumbnail = screen.container.querySelector<HTMLImageElement>('.thumb-media');
  const before = thumbnail?.src;

  await page.getByRole('button', { name: 'Preview photo.png' }).click();
  const crop = page.getByRole('button', { name: 'Crop photo.png' });
  await crop.click();
  await expect.element(page.getByRole('dialog', { name: 'Crop image' })).toBeVisible();

  await userEvent.keyboard('{Escape}');
  await expect.element(page.getByRole('dialog', { name: 'Crop image' })).not.toBeInTheDocument();
  await expect.element(crop).toBeVisible();
  expect(onReplace).not.toHaveBeenCalled();

  await crop.click();
  await page.getByRole('radio', { name: '1:1' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => onReplace.mock.calls.length).toBe(1);
  await expect.element(page.getByRole('dialog', { name: 'Crop image' })).not.toBeInTheDocument();
  await expect.element(crop).toBeVisible();

  const [id, cropped] = onReplace.mock.calls[0];
  expect(id).toBe(7);
  const bitmap = await createImageBitmap(cropped);
  expect([bitmap.width, bitmap.height]).toEqual([400, 400]);
  bitmap.close();
  expect(files[0]).toMatchObject({ id: 7, spoiler: true, file: cropped });

  await screen.rerender({ files });
  await expect
    .poll(() => screen.container.querySelector<HTMLImageElement>('.thumb-media')?.src)
    .not.toBe(before);
  expect(document.activeElement?.closest('.staged-viewer')).not.toBeNull();
});

test('the staged viewer keeps each action label on one line at phone width', async () => {
  await page.viewport(360, 780);
  await render(ComposerAttachments, {
    files: [{ id: 7, file: await png(800, 400), spoiler: false, metadata: 'location' }],
    onRemove: vi.fn(),
    onToggleSpoiler: vi.fn(),
    onSetMetadata: vi.fn(),
    onReplace: vi.fn(),
  });

  await page.getByRole('button', { name: 'Preview photo.png' }).click();
  await expect.element(page.getByRole('button', { name: 'Crop photo.png' })).toBeVisible();
  const labels = [...document.querySelectorAll('.staged-viewer-actions .btn')].map((button) => {
    const text = [...button.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''
    );
    if (!text) throw new Error('Action has no label');
    const range = document.createRange();
    range.selectNodeContents(text);
    return { label: text.textContent?.trim(), lines: range.getClientRects().length };
  });
  expect(labels).toEqual(
    ['Spoiler', 'Crop', 'Options', 'Remove'].map((label) => ({ label, lines: 1 }))
  );
  await page.viewport(414, 896);
});
