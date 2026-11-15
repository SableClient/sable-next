import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { StagedFile } from '#lib/composer/composer-files.js';

import ComposerAttachments from './ComposerAttachments.svelte';

function video(file: File, gif?: boolean): StagedFile {
  return { id: 3, file, spoiler: false, metadata: 'location', gif };
}

function junk(): File {
  return new File(['clip'], 'clip.mp4', { type: 'video/mp4' });
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
  await render(ComposerAttachments, props([video(junk())], onSetGif));

  await page.getByRole('button', { name: 'Playback for clip.mp4' }).click();
  await expect
    .element(page.getByRole('menuitemradio', { name: /^Automatic/ }))
    .toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'GIF: loops without sound' }).click();

  expect(onSetGif).toHaveBeenCalledWith(3, true);
});

test('a video chosen as a GIF says so on its thumbnail', async () => {
  const screen = await render(ComposerAttachments, props([video(junk(), true)]));

  expect(screen.container.querySelector('.thumb-badge')?.textContent.trim()).toBe('GIF');
  await expect
    .element(page.getByRole('button', { name: 'Preview clip.mp4, sends as a GIF' }))
    .toBeVisible();
});

test('a silent clip left on automatic shows that it will send as a GIF', async () => {
  const clip = new URL(
    '../../../../crates/sable-model/tests/fixtures/clips/silent.mp4',
    import.meta.url
  );
  const bytes = await (await fetch(clip)).blob();
  await render(
    ComposerAttachments,
    props([video(new File([bytes], 'clip.mp4', { type: 'video/mp4' }))])
  );

  await expect
    .element(page.getByRole('button', { name: 'Preview clip.mp4, sends as a GIF' }))
    .toBeVisible();
  await page.getByRole('button', { name: 'Playback for clip.mp4' }).click();
  await expect
    .element(page.getByRole('menuitemradio', { name: 'Automatic: sends as a GIF' }))
    .toHaveAttribute('aria-checked', 'true');
});
