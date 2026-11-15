import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { StagedFile } from '#lib/composer/composer-files.js';

import ComposerAttachments from './ComposerAttachments.svelte';

function video(gif?: boolean): StagedFile {
  return {
    id: 3,
    file: new File(['clip'], 'clip.mp4', { type: 'video/mp4' }),
    spoiler: false,
    metadata: 'location',
    gif,
  };
}

function props(files: StagedFile[], onSetGif = vi.fn()) {
  return {
    files,
    onRemove: vi.fn(),
    onToggleSpoiler: vi.fn(),
    onSetMetadata: vi.fn(),
    onSetGif,
    onReplace: vi.fn(),
  };
}

test('a staged video can be sent as a GIF or back to automatic', async () => {
  const onSetGif = vi.fn();
  await render(ComposerAttachments, props([video()], onSetGif));

  await page.getByRole('button', { name: 'Options for clip.mp4' }).click();
  await expect
    .element(page.getByRole('menuitemradio', { name: 'Automatic: GIF if silent' }))
    .toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Play as GIF' }).click();

  expect(onSetGif).toHaveBeenCalledWith(3, true);
});

test('a video chosen as a GIF says so on its thumbnail', async () => {
  const screen = await render(ComposerAttachments, props([video(true)]));

  expect(screen.container.querySelector('.thumb-badge')?.textContent.trim()).toBe('GIF');
});
