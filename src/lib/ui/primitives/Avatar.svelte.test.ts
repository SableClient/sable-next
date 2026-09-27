// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import Avatar from './Avatar.svelte';
import { identityColor } from './identity-color.js';

afterEach(() => {
  core.fetchMedia.mockReset();
  vi.useRealTimers();
});

function root(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.avatar-root');
  if (!element) throw new Error('avatar not rendered');
  return element;
}

function fallback(): HTMLElement | null {
  return root().querySelector('.avatar-fallback');
}

function picture(): HTMLElement | null {
  return root().querySelector('.avatar-image');
}

test('paints the colour on the fallback, never on the root', () => {
  render(Avatar, { name: 'Sable', color: 'rgb(1, 2, 3)' });

  expect(root().style.background).toBe('');
  expect(fallback()?.style.background).toBe('rgb(1, 2, 3)');
});

test('derives the fallback colour from the id when the caller names none', () => {
  render(Avatar, { name: 'Sable', id: '@sable:example.org' });

  expect(fallback()?.style.background).toBe(identityColor('@sable:example.org'));
  expect(fallback()?.style.color).toBe('var(--avatar-identity-on-plate)');
});

test('tints the picture box until the picture paints, and never the root', () => {
  render(Avatar, {
    props: { src: 'mxc://example.org/avatar', name: 'Sable', id: '@sable:example.org' },
  });

  expect(picture()?.style.background).toBe(identityColor('@sable:example.org'));
  expect(root().style.background).toBe('');
  expect(fallback()?.style.display).toBe('none');
});

test('a picture the media layer cannot fetch falls back to the initials at once', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new Error('gone'));
  render(Avatar, {
    props: { src: 'mxc://example.org/gone', name: 'Sable', id: '@sable:example.org' },
  });

  await vi.advanceTimersByTimeAsync(0);

  expect(fallback()?.style.display).toBe('');
});

test('shows the initials while a transient failure retries, then the picture', async () => {
  vi.useFakeTimers();
  core.fetchMedia
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(new Uint8Array([1]));
  render(Avatar, {
    props: { src: 'mxc://example.org/retrying', name: 'Sable', id: '@sable:example.org' },
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(fallback()?.style.display).toBe('');

  await vi.advanceTimersByTimeAsync(2_000);
  picture()?.querySelector('img')?.dispatchEvent(new Event('load'));
  await tick();

  expect(fallback()?.style.display).toBe('none');
});

test('an undecodable picture falls back to the initials', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  render(Avatar, {
    props: { src: 'mxc://example.org/undecodable-avatar', name: 'Sable' },
  });

  for (let step = 0; step < 2; step += 1) {
    await vi.advanceTimersByTimeAsync(0);
    picture()?.querySelector('img')?.dispatchEvent(new Event('error'));
  }
  await vi.advanceTimersByTimeAsync(0);

  expect(fallback()?.style.display).toBe('');
});

test('leaves a picture on a transparent box, so a transparent png keeps its own shape', () => {
  render(Avatar, {
    props: { src: 'https://example.org/avatar.png', name: 'Sable', color: 'rgb(1, 2, 3)' },
  });

  expect(root().style.background).toBe('');
});

test('removes the old picture when its reactive source is cleared', async () => {
  const props = $state<{ src: string | null; name: string }>({
    src: 'mxc://example.org/avatar',
    name: 'Sable',
  });
  render(Avatar, { props });

  expect(picture()).toBeInTheDocument();

  props.src = null;
  await tick();

  expect(picture()).not.toBeInTheDocument();
  expect(fallback()).toBeInTheDocument();
});

function hoverRow(pointerType: string, type = 'pointerenter'): HTMLElement {
  const row = document.querySelector('article');
  if (!row) throw new Error('row not rendered');
  row.dispatchEvent(new PointerEvent(type, { pointerType }));
  return row;
}

test('hovering the row plays the original over the still thumbnail', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const article = document.body.appendChild(document.createElement('article'));
  onTestFinished(() => {
    article.remove();
  });
  render(Avatar, { target: article, props: { src: 'mxc://example.org/animated', name: 'Sable' } });
  await tick();

  expect(root().querySelectorAll('.avatar-image')).toHaveLength(1);
  expect(core.fetchMedia).not.toHaveBeenCalledWith('mxc://example.org/animated', 0, 0);

  hoverRow('mouse');
  await tick();

  expect(root().querySelectorAll('.avatar-image')).toHaveLength(2);
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/animated', 0, 0);

  hoverRow('mouse', 'pointerleave');
  await tick();

  expect(root().querySelectorAll('.avatar-image')).toHaveLength(1);
});

test('a touch on the row does not fetch the original', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const article = document.body.appendChild(document.createElement('article'));
  onTestFinished(() => {
    article.remove();
  });
  render(Avatar, { target: article, props: { src: 'mxc://example.org/touched', name: 'Sable' } });

  hoverRow('touch');
  await tick();

  expect(root().querySelectorAll('.avatar-image')).toHaveLength(1);
});
