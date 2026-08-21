// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
  roomPreview: vi.fn<() => Promise<{ name: string | null }>>(),
}));

const roomList = vi.hoisted(() => ({
  rooms: [] as { room_id: string; canonical_alias: string | null; name: string | null }[],
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => roomList,
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import FormattedBody from './FormattedBody.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  core.roomPreview.mockReset();
  core.roomPreview.mockResolvedValue({ name: null });
  roomList.rooms = [];
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

test('turns a bare room permalink into a room mention', async () => {
  const url = 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe';
  const instance = mount(FormattedBody, { target: document.body, props: { html: url } });
  await tick();

  const anchor = document.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.href).toBe(url);
  expect(anchor?.dataset.matrixLink).toBe('room');
  expect(anchor?.textContent).toBe('!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI');
  await unmount(instance);
});

test('resolves a room permalink name through its via server', async () => {
  core.roomPreview.mockResolvedValue({ name: 'Sable' });
  const url = 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe';
  const instance = mount(FormattedBody, { target: document.body, props: { html: url } });

  await vi.waitFor(() => {
    expect(document.querySelector('a')?.textContent).toBe('#Sable');
  });
  expect(core.roomPreview).toHaveBeenCalledWith('!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI', [
    'sable.moe',
  ]);
  await unmount(instance);
});

test('uses the local room-list name before requesting a preview', async () => {
  roomList.rooms = [
    {
      room_id: '!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI',
      canonical_alias: null,
      name: 'Sable',
    },
  ];
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe',
    },
  });

  await vi.waitFor(() => {
    expect(document.querySelector('a')?.textContent).toBe('#Sable');
  });
  expect(core.roomPreview).not.toHaveBeenCalled();
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
  expect(anchor?.rel).toBe('noopener noreferrer');
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

test('leaves a remote image for the browser and drops a source with no scheme behind it', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html:
        '<img src="https://example.org/badge.png" alt="no-ai">' +
        '<img src="cid:attached" alt="party" data-mx-emoticon="">',
    },
  });
  await tick();

  const images = document.querySelectorAll('img');
  expect(images).toHaveLength(1);
  expect(images[0].getAttribute('src')).toBe('https://example.org/badge.png');
  expect(core.fetchMedia).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(':party:');
  await unmount(instance);
});

test('a code block gains a language label and a copy control', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: { html: '<pre><code class="language-rust">fn main() {}</code></pre>' },
  });
  await tick();

  expect(document.querySelector('.code-language')?.textContent).toBe('rust');
  expect(document.querySelector('[data-code-copy]')).not.toBeNull();
  // Short blocks are not collapsible.
  expect(document.querySelector('[data-code-toggle]')).toBeNull();
  expect(document.querySelector('.code-block')?.hasAttribute('data-collapsed')).toBe(false);
  await unmount(instance);
});

test('an unlabelled block falls back to a generic label', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: { html: '<pre><code>plain</code></pre>' },
  });
  await tick();

  expect(document.querySelector('.code-language')?.textContent).toBe('Code');
  await unmount(instance);
});

test('a long block starts collapsed and expands on demand', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n');
  const instance = mount(FormattedBody, {
    target: document.body,
    props: { html: `<pre><code>${lines}</code></pre>` },
  });
  await tick();

  const block = document.querySelector('.code-block');
  const toggle = document.querySelector<HTMLButtonElement>('[data-code-toggle]');
  expect(block?.hasAttribute('data-collapsed')).toBe(true);
  expect(toggle?.textContent).toBe('Expand');

  toggle?.click();
  await tick();

  expect(block?.hasAttribute('data-collapsed')).toBe(false);
  expect(toggle?.textContent).toBe('Collapse');
  await unmount(instance);
});

test('an unhighlightable language leaves the escaped source intact', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: '<pre><code class="language-notalanguage">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    },
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const code = document.querySelector('pre code');
  expect(code?.textContent).toBe('<script>alert(1)</script>');
  expect(code?.querySelector('script')).toBeNull();
  await unmount(instance);
});

test('renders a settings link as a labelled chip', async () => {
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      html: `<a href="${location.origin}/settings/timeline?focus=hide-read-receipts">${location.origin}/settings/timeline?focus=hide-read-receipts</a>`,
    },
  });
  await tick();

  const anchor = document.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.dataset.settingsLink).toBe('timeline');
  expect(anchor?.dataset.settingsLinkFocus).toBe('hide-read-receipts');
  expect(anchor?.textContent).toBe('Timeline / Hide read receipts');
  // The app-level delegate follows it, so the anchor is not sent to a new tab.
  expect(anchor?.target).toBe('');
  await unmount(instance);
});
