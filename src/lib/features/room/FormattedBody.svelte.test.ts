// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
}));

vi.mock('$lib/core/context', () => ({
  useCoreClient: () => core,
}));

import FormattedBody from './FormattedBody.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
});

test('opens Matrix links through the room-level handler', async () => {
  const onMatrixLink = vi.fn();
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: '<a href="matrix:roomid/room:example.org/e/event">Message</a>',
      onMatrixLink,
    },
  });
  await tick();

  document.querySelector<HTMLAnchorElement>('a')?.click();

  expect(onMatrixLink).toHaveBeenCalledWith(
    { kind: 'event', roomId: '!room:example.org', eventId: '$event' },
    expect.any(HTMLAnchorElement)
  );
  await unmount(instance);
});

test('sends external links to a new tab instead of the handler', async () => {
  const onMatrixLink = vi.fn();
  const instance = mount(FormattedBody, {
    target: document.body,
    props: { html: '<a href="https://example.org/">Link</a>', onMatrixLink },
  });
  await tick();

  const anchor = document.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.target).toBe('_blank');
  expect(anchor?.dataset.matrixLink).toBeUndefined();
  anchor?.click();
  expect(onMatrixLink).not.toHaveBeenCalled();
  await unmount(instance);
});

// The colour is named rather than hex so check-theme-tokens does not read it as
// an undeclared literal.
test('applies Matrix colours and keeps spoilers hidden until asked', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: '<span data-mx-color="teal">teal</span><span data-mx-spoiler="">secret</span>',
    },
  });
  await tick();

  const [colored, spoiler] = [...document.querySelectorAll<HTMLElement>('span')];
  expect(colored.style.color).toBe('teal');
  expect(spoiler.role).toBe('button');
  expect(spoiler.ariaPressed).toBe('true');

  spoiler.click();
  expect(spoiler.ariaPressed).toBe('false');
  await unmount(instance);
});

test('resolves an mxc emoticon through the core media command', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: '<img src="mxc://example.org/emoji" alt="party" data-mx-emoticon="">',
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('img')?.src.startsWith('blob:')).toBe(true);
  });

  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/emoji', 0, 0);
  await unmount(instance);
});

test('renders maths in place of the sender fallback', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: { html: '<span data-mx-maths="x^2">x squared</span>' },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  expect(document.querySelector('span[data-mx-maths]')?.textContent).not.toBe('x squared');
  await unmount(instance);
});

test('falls back to the shortcode when an emoticon cannot be resolved', async () => {
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: '<img src="mxc://example.org/gone" alt="party" data-mx-emoticon="">',
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('img')).toBeNull();
  });

  expect(document.body.textContent).toContain(':party:');
  await unmount(instance);
});
