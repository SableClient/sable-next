// @vitest-environment happy-dom

import { fireEvent, render, screen, type RenderResult } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const roomList = vi.hoisted(() => ({
  rooms: [] as { room_id: string; canonical_alias: string | null; name: string | null }[],
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => roomList,
}));

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomPreview: vi.fn<() => Promise<{ name: string | null }>>(),
  eventItems: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
});

import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import FormattedBody from './FormattedBody.svelte';
import FormattedBodyHarness from './FormattedBodyHarness.test.svelte';
import FormattedBodyMediaHarness from './FormattedBodyMediaHarness.test.svelte';

const user = userEvent.setup();
const link = () => screen.getByRole('link');

test('keeps table semantics inside a keyboard-accessible scroller', async () => {
  render(FormattedBody, {
    props: { html: '<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>' },
  });
  await tick();
  const table = screen.getByRole('table');
  expect(screen.getByRole('columnheader')).toHaveTextContent('Name');
  expect(screen.getByRole('cell')).toHaveTextContent('Alice');
  const scroller = table.parentElement;
  expect(scroller).toHaveClass('table-scroll');
  scroller?.focus();
  expect(scroller).toHaveFocus();
});

afterEach(() => {
  core.fetchMedia.mockReset();
  core.roomPreview.mockReset();
  core.roomPreview.mockResolvedValue({ name: null });
  roomList.rooms = [];
  preferences.pauseAnimationsWhenInactive = false;
  preferences.mediaAutoLoad = 'on';
  vi.restoreAllMocks();
});

test('opens Matrix links through the room-level handler', async () => {
  const onMatrixLink = vi.fn();
  const onDocumentClick = vi.fn();
  document.addEventListener('click', onDocumentClick);
  render(FormattedBody, {
    props: {
      html: '<a href="https://matrix.to/#/!room:example.org/$event">Message</a>',
      onMatrixLink,
    },
  });
  await tick();

  await user.click(link());

  expect(onMatrixLink).toHaveBeenCalledWith(
    { kind: 'event', roomId: '!room:example.org', eventId: '$event' },
    expect.any(HTMLAnchorElement)
  );
  expect(onDocumentClick).not.toHaveBeenCalled();
  document.removeEventListener('click', onDocumentClick);
});

test.each([
  '<a href="matrix:u/ana:example.org">Ana</a>',
  '<a href="matrix:somethingnewer/abc">Future</a>',
])('never lets a matrix: link reach the browser: %s', async (html) => {
  render(FormattedBody, { props: { html } });
  await tick();

  expect(await fireEvent.click(link())).toBe(false);
});

test.each([
  ['\u2190', '@ezera'],
  ['Ana', '@ezera'],
  ['hello', '@ezera'],
  ['https://matrix.to/#/@ezera:example.org', '@ezera'],
])('labels a user mention %s with the member name', async (label, expected) => {
  render(FormattedBody, {
    props: { html: `<a href="https://matrix.to/#/@ezera:example.org">${label}</a>` },
  });
  await tick();

  expect(screen.getByRole('link', { name: expected })).toHaveAttribute('data-matrix-link', 'user');
});

test('keeps the author text on a user mention when asked to', async () => {
  render(FormattedBody, {
    props: {
      html: '<a href="https://matrix.to/#/@ezera:example.org">@ezera \u2192</a>',
      keepMentionText: true,
    },
  });
  await tick();

  expect(screen.getByRole('link', { name: '@ezera \u2192' })).toHaveAttribute(
    'data-matrix-link',
    'user'
  );
});

test('turns a room permalink whose label is its href into a room mention', async () => {
  const url = 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe';
  render(FormattedBody, {
    props: { html: `<a href="${url}">${url}</a>` },
  });
  await tick();

  const anchor = screen.getByRole('link', { name: '!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI' });
  expect(anchor).toHaveAttribute('href', url);
  expect(anchor).toHaveAttribute('data-matrix-link', 'room');
});

test('renders an @room mention as a chip', async () => {
  render(FormattedBody, {
    props: { html: 'Heads up <span data-mx-room-mention>@room</span>' },
  });
  await tick();

  expect(screen.getByText('@room')).toHaveAttribute('data-mx-room-mention');
});

test('resolves a room permalink name through its via server', async () => {
  core.roomPreview.mockResolvedValue({ name: 'Sable' });
  const url = 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe';
  render(FormattedBody, {
    props: { html: `<a href="${url}">${url}</a>` },
  });

  expect(await screen.findByRole('link', { name: '#Sable' })).toBeInTheDocument();
  expect(core.roomPreview).toHaveBeenCalledWith('!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI', [
    'sable.moe',
  ]);
});

test('uses the local room-list name before requesting a preview', async () => {
  roomList.rooms = [
    {
      room_id: '!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI',
      canonical_alias: null,
      name: 'Sable',
    },
  ];
  const url = 'https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe';
  render(FormattedBody, {
    props: { html: `<a href="${url}">${url}</a>` },
  });

  expect(await screen.findByRole('link', { name: '#Sable' })).toBeInTheDocument();
  expect(core.roomPreview).not.toHaveBeenCalled();
});

test('sends external links to a new tab instead of the handler', async () => {
  const onMatrixLink = vi.fn();
  render(FormattedBodyHarness, {
    props: { html: '<a href="https://example.org/">Link</a>', entries: [], onMatrixLink },
  });
  await tick();

  const anchor = screen.getByRole('link', { name: 'Link' });
  expect(anchor).toHaveAttribute('target', '_blank');
  expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  expect(anchor).not.toHaveAttribute('data-matrix-link');
  await user.click(anchor);
  expect(onMatrixLink).not.toHaveBeenCalled();
});

test('a link in a message body is not draggable', async () => {
  render(FormattedBodyHarness, {
    props: {
      html: '<a href="https://example.org/">Link</a> <a href="https://matrix.to/#/@alice:example.org">Alice</a>',
      entries: [],
    },
  });
  await tick();

  for (const anchor of screen.getAllByRole('link'))
    expect(anchor).toHaveAttribute('draggable', 'false');
});

// The colour is named rather than hex so check-theme-tokens does not read it as
// an undeclared literal.
test('applies Matrix colours and keeps spoilers hidden until asked', async () => {
  render(FormattedBody, {
    props: {
      html: '<span data-mx-color="teal">teal</span><span data-mx-spoiler="">secret</span>',
    },
  });
  await tick();

  expect(screen.getByText('teal').style.color).toBe('teal');
  const spoiler = screen.getByRole('button', { name: 'secret' });
  expect(spoiler.ariaPressed).toBe('true');

  await user.click(spoiler);
  expect(spoiler.ariaPressed).toBe('false');
});

test('inline image hiding is local and leaves custom emotes alone', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(FormattedBody, {
    html: '<img src="mxc://example.org/local-photo" alt="Photo"><img data-mx-emoticon="" src="mxc://example.org/local-emote" alt=":party:">',
  });
  await tick();
  await user.click(screen.getByRole('button', { name: 'Hide image' }));
  expect(document.querySelector('.inline-image')).toHaveClass('spoilered');
  expect(screen.queryByRole('img', { name: 'Photo' })).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: ':party:' }).closest('.inline-image')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Reveal image' }));
  expect(screen.getByRole('img', { name: 'Photo' })).toBeInTheDocument();
});

test.each([
  '<span data-mx-spoiler="Ending"><img src="mxc://example.org/ending" alt="Secret ending"></span>',
  '<a href="https://example.org/photo">Before <span data-mx-spoiler="Ending"><img src="mxc://example.org/ending" alt="Secret ending"></span> after</a>',
])(
  'an image-only inline spoiler has a crossed-eye control and a private label: %s',
  async (html) => {
    core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
    render(FormattedBody, {
      html,
    });
    await tick();
    const reveal = screen.getByRole('button', { name: 'Reveal image' });
    expect(reveal).toHaveAccessibleDescription('Ending');
    expect(document.querySelector('.inline-image')).toHaveClass('spoilered');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    reveal.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('img', { name: 'Secret ending' })).toBeInTheDocument();
  }
);

test.each([
  '<a href="https://example.org/photo"><img src="https://example.org/photo.png" alt="Photo"></a>',
  '<a href="https://example.org/photo">Before <img src="https://example.org/photo.png" alt="Photo"> after</a>',
  '<a href="https://example.org/photo">Before <img src="https://example.org/photo.png" alt="Photo"></a>',
  '<a href="https://example.org/photo"><img src="https://example.org/photo.png" alt="Photo"> after</a>',
])('inline linked images keep hide controls outside their links: %s', async (html) => {
  const view = render(FormattedBody, { html });
  await tick();
  const hide = screen.getByRole('button', { name: 'Hide image' });
  expect(hide.closest('a')).toBeNull();
  expect([...document.querySelectorAll('a')].every((anchor) => anchor.hasChildNodes())).toBe(true);
  expect(screen.getByRole('img', { name: 'Photo' }).closest('a')).toHaveAttribute(
    'href',
    'https://example.org/photo'
  );
  await user.click(hide);
  expect(document.querySelector('.inline-image')).toHaveClass('spoilered');
  await view.rerender({ html: '<p>Replacement message</p>' });
  expect(screen.queryByRole('button', { name: 'Reveal image' })).not.toBeInTheDocument();
  expect(screen.getByText('Replacement message')).toBeInTheDocument();
});

test('every image in an inline spoiler starts hidden and reveals independently', async () => {
  render(FormattedBody, {
    html: '<span data-mx-spoiler="Ending"><img src="https://example.org/one.png" alt="First secret"><img src="https://example.org/two.png" alt="Second secret"></span>',
  });
  await tick();
  const controls = screen.getAllByRole('button', { name: 'Reveal image' });
  expect(controls).toHaveLength(2);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  await user.click(controls[0]);
  expect(screen.getByRole('img', { name: 'First secret' })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Second secret' })).not.toBeInTheDocument();
});

test('resolves an mxc emoticon through the core media command', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));
  render(FormattedBody, {
    props: {
      html: '<img src="mxc://example.org/emoji" alt="party" data-mx-emoticon="">',
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(screen.getByRole('img', { name: 'party' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/)
    );
  });

  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/emoji', 0, 0);
});

test('pixelates a small emote by its decoded size, following the setting', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(20);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(20);
  preferences.pixelatedImages = 'smart';
  render(FormattedBody, {
    props: { html: '<img src="mxc://example.org/tiny" alt=":tiny:" data-mx-emoticon="">' },
  });
  const image = screen.getByRole('img', { name: ':tiny:' });
  await vi.waitFor(() => {
    expect(image).toHaveAttribute('src', expect.stringMatching(/^blob:/));
  });
  image.dispatchEvent(new Event('load'));
  expect(image).toHaveClass('pixelated');

  preferences.pixelatedImages = 'never';
  await tick();
  expect(image).not.toHaveClass('pixelated');
  preferences.pixelatedImages = 'smart';
});

test('preserves a custom emote marker', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));
  render(FormattedBody, {
    props: {
      html: '<img data-mx-emoticon src="mxc://example.org/emoji" alt=":party:" title=":party:" height="32">',
    },
  });
  await tick();

  expect(screen.getByRole('img', { name: ':party:' })).toHaveAttribute('data-mx-emoticon', '');
});

test('defers an mxc emoticon source until its Blob URL is ready', async () => {
  core.fetchMedia.mockReturnValue(new Promise(() => {}));
  render(FormattedBody, {
    props: {
      html: '<img data-mx-emoticon="" src="mxc://example.org/delayed" alt=":party:">',
    },
  });
  await tick();

  const image = screen.getByRole('img', { name: ':party:' });
  expect(image).not.toHaveAttribute('src');
  expect(image).toHaveAttribute('data-sable-src', 'mxc://example.org/delayed');
});

async function paintedEmote(
  source: string
): Promise<{ image: HTMLImageElement; instance: RenderResult<typeof FormattedBody> }> {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;still');
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));
  const instance = render(FormattedBody, {
    props: { html: `<img src="${source}" alt="party" data-mx-emoticon="">` },
  });
  await vi.waitFor(() => {
    expect(screen.getByRole('img', { name: 'party' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/)
    );
  });
  const image = screen.getByRole<HTMLImageElement>('img', { name: 'party' });
  Object.defineProperty(image, 'complete', { value: true });
  Object.defineProperty(image, 'naturalWidth', { value: 32 });
  Object.defineProperty(image, 'naturalHeight', { value: 32 });
  return { image, instance };
}

test('holds inline emotes still while the window is inactive', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  const { image } = await paintedEmote('mxc://example.org/held-emote');
  const animated = image.src;
  image.dispatchEvent(new Event('load'));
  expect(image.src).toBe(animated);

  focused = false;
  window.dispatchEvent(new Event('blur'));
  await tick();
  expect(image.src).toBe('data:image/png;still');

  focused = true;
  window.dispatchEvent(new Event('focus'));
  await tick();
  expect(image.src).toBe(animated);
});

test('an emote that arrives while the window is inactive loads still', async () => {
  preferences.pauseAnimationsWhenInactive = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const { image } = await paintedEmote('mxc://example.org/late-emote');

  image.dispatchEvent(new Event('load'));

  expect(image.src).toBe('data:image/png;still');
});

test('renders maths in place of the sender fallback', async () => {
  render(FormattedBody, {
    props: { html: '<span data-mx-maths="x^2">x squared</span>' },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  expect(document.querySelector('span[data-mx-maths]')?.textContent).not.toBe('x squared');
});

test('falls back to the shortcode once an emoticon has run out of retries', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new Error('media unavailable'));
  const instance = render(FormattedBody, {
    props: {
      html: '<img src="mxc://example.org/gone" alt="party" data-mx-emoticon="">',
    },
  });
  await vi.advanceTimersByTimeAsync(0);

  expect(core.fetchMedia).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('img', { name: 'party' })).toBeInTheDocument();

  await vi.advanceTimersByTimeAsync(2000);
  expect(core.fetchMedia).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(4000);

  expect(core.fetchMedia).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText(/:party:/)).toBeInTheDocument();
  instance.unmount();
  vi.useRealTimers();
});

test('leaves a remote image for the browser and drops a source with no scheme behind it', async () => {
  render(FormattedBody, {
    props: {
      html:
        '<img src="https://example.org/badge.png" alt="no-ai">' +
        '<img src="cid:attached" alt="party" data-mx-emoticon="">',
    },
  });
  await tick();

  const images = screen.getAllByRole('img');
  expect(images).toHaveLength(1);
  expect(images[0]).toHaveAttribute('src', 'https://example.org/badge.png');
  expect(core.fetchMedia).not.toHaveBeenCalled();
  expect(screen.getByText(/:party:/)).toBeInTheDocument();
});

test('a code block gains a language label and a copy control', async () => {
  render(FormattedBody, {
    props: { html: '<pre><code class="language-rust">fn main() {}</code></pre>' },
  });
  await tick();

  expect(screen.getByText('rust')).toHaveClass('code-language');
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  // Short blocks are not collapsible.
  expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
  expect(document.querySelector('.code-block')).not.toHaveAttribute('data-collapsed');
});

test('reads the language off the pre when the code element carries none', async () => {
  render(FormattedBody, {
    props: { html: '<pre class="language-go"><code>x</code></pre>' },
  });
  await tick();

  expect(screen.getByText('go')).toHaveClass('code-language');
});

test('a code block drops the newline the fence left at its end', async () => {
  render(FormattedBody, {
    props: { html: '<pre><code>one\ntwo\n</code></pre>' },
  });
  await tick();

  expect(document.querySelector('pre code')?.textContent).toBe('one\ntwo');
});

test('an unlabelled block falls back to a generic label', async () => {
  render(FormattedBody, {
    props: { html: '<pre><code>plain</code></pre>' },
  });
  await tick();

  expect(screen.getByText('Code')).toHaveClass('code-language');
});

test('a long block starts collapsed and expands on demand', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n');
  render(FormattedBody, {
    props: { html: `<pre><code>${lines}</code></pre>` },
  });
  await tick();

  const block = document.querySelector('.code-block');
  expect(block).toHaveAttribute('data-collapsed');

  await user.click(screen.getByRole('button', { name: 'Expand' }));

  expect(block).not.toHaveAttribute('data-collapsed');
  expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
});

test('an unhighlightable language leaves the escaped source intact', async () => {
  render(FormattedBody, {
    props: {
      html: '<pre><code class="language-notalanguage">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    },
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const code = document.querySelector('pre code');
  expect(code?.textContent).toBe('<script>alert(1)</script>');
  expect(code?.querySelector('script')).toBeNull();
});

test('keeps a matrix link out of the app when nothing handles it', async () => {
  render(FormattedBody, {
    props: { html: '<a href="https://matrix.to/#/@ana:example.org">Ana</a>' },
  });
  await tick();

  const anchor = screen.getByRole('link', { name: '@ana' });
  expect(anchor).toHaveAttribute('data-matrix-link', 'user');
  expect(anchor).toHaveAttribute('target', '_blank');
  expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
});

test('renders a settings link as a labelled chip', async () => {
  render(FormattedBody, {
    props: {
      html: `<a href="${location.origin}/settings/timeline?focus=hide-read-receipts">${location.origin}/settings/timeline?focus=hide-read-receipts</a>`,
    },
  });
  await tick();

  const anchor = screen.getByRole('link', { name: 'Timeline / Hide read receipts' });
  expect(anchor).toHaveAttribute('data-settings-link', 'timeline');
  expect(anchor).toHaveAttribute('data-settings-link-focus', 'hide-read-receipts');
});

test('shows a room abbreviation definition in a tooltip on hover', async () => {
  render(FormattedBodyHarness, {
    props: {
      html: '<p>a foss build</p>',
      entries: [{ term: 'FOSS', definition: 'Free and open source software' }],
    },
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const abbr = screen.getByText('foss');
  expect(abbr.tagName).toBe('ABBR');

  await user.hover(abbr);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(document.querySelector('.tooltip')?.textContent.trim()).toBe(
    'Free and open source software'
  );
});

test('shows the target of a link whose text differs from it on hover', async () => {
  render(FormattedBodyHarness, {
    props: { html: '<p><a href="https://example.com/a">click here</a></p>', entries: [] },
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await user.hover(screen.getByRole('link', { name: 'click here' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(document.querySelector('.tooltip')?.textContent.trim()).toBe('https://example.com/a');
});

test('shows no tooltip for a link whose text is its own address', async () => {
  render(FormattedBodyHarness, {
    props: { html: '<p><a href="https://example.com/">https://example.com/</a></p>', entries: [] },
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await user.hover(screen.getByRole('link', { name: 'https://example.com/' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(document.querySelector('.tooltip')).not.toBeInTheDocument();
});

const TIME = '<time datetime="1970-01-01T00:00:00Z">1 Jan 1970, 00:00 (UTC)</time>';

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('the sender zone reaches a time chip without rebuilding the body', async () => {
  const props = $state({
    html: `<p>${TIME} <span data-mx-spoiler="">secret</span></p>`,
    entries: [],
    senderTimezone: null as string | null,
  });
  render(FormattedBodyHarness, { props });
  await settle();

  const chip = document.querySelector<HTMLButtonElement>('.time-chip');
  if (!chip) throw new Error('time chip missing');
  const spoiler = screen.getByRole('button', { name: 'secret' });
  await user.click(spoiler);
  expect(spoiler.ariaPressed).toBe('false');
  expect(chip.ariaLabel).not.toContain('Asia/Tokyo');

  await user.hover(chip);
  await settle();
  expect(document.querySelector('.tooltip')?.textContent).toContain('UTC');

  props.senderTimezone = 'Asia/Tokyo';
  await settle();

  expect(document.querySelector('.time-chip')).toBe(chip);
  expect(spoiler.ariaPressed).toBe('false');
  expect(chip.ariaLabel).toContain('Asia/Tokyo');
  expect(document.querySelector('.tooltip')?.textContent).toContain('Asia/Tokyo');
});

test('a time chip inside a hidden spoiler reveals it instead of its time', async () => {
  render(FormattedBodyHarness, {
    props: { html: `<span data-mx-spoiler="">${TIME}</span>`, entries: [] },
  });
  await settle();

  const chip = document.querySelector<HTMLElement>('.time-chip');
  const spoiler = document.querySelector<HTMLElement>('[data-mx-spoiler]');
  if (!chip || !spoiler) throw new Error('spoilered time chip missing');
  await user.hover(chip);
  await user.click(chip);
  await settle();

  expect(spoiler.ariaPressed).toBe('false');
  expect(document.querySelector('.tooltip')).not.toBeInTheDocument();

  await user.unhover(chip);
  await user.hover(chip);
  await settle();
  expect(document.querySelector('.tooltip')).not.toBeNull();
});

test('a time inside a link stays part of the link', async () => {
  render(FormattedBody, {
    props: { html: `<a href="https://example.org/">${TIME}</a>` },
  });
  await tick();

  const chip = link().querySelector<HTMLElement>('.time-chip');
  if (!chip) throw new Error('time chip missing');
  expect(chip.tagName).toBe('SPAN');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();

  expect(await fireEvent.click(chip)).toBe(true);
});

test('a bare event link names the room and quotes the message, with an icon', async () => {
  roomList.rooms = [{ room_id: '!room:example.org', canonical_alias: null, name: 'Design' }];
  core.eventItems.mockResolvedValue([
    { content: { kind: 'message', body: `ship it\n${'x'.repeat(100)}`, html: null } },
  ]);
  const url = 'https://matrix.to/#/!room:example.org/$event';
  render(FormattedBody, {
    props: { html: `<a href="${url}">${url}</a>` },
  });

  const anchor = link();
  await vi.waitFor(() => {
    expect(anchor.textContent).toMatch(/^#Design: ship it x+…$/);
  });
  expect(anchor.textContent).toHaveLength('#Design: '.length + 72);
  expect(anchor.querySelector('.link-chip-icon svg')).toBeInTheDocument();
  expect(core.eventItems).toHaveBeenCalledWith('!room:example.org', ['$event']);
});

test('inline images wait behind a prompt where the media preview setting says so (MSC4278)', async () => {
  mediaPreviewSettings.global = { media_previews: 'off' };
  render(FormattedBodyMediaHarness, {
    props: {
      html:
        '<img src="https://example.org/cat.png" alt="cat">' +
        '<img data-mx-emoticon="" src="mxc://example.org/party" alt="party">',
      joinRule: 'invite',
    },
  });
  await tick();

  const cat = document.querySelector<HTMLImageElement>('img[alt="cat"]');
  expect(cat).not.toHaveAttribute('src');
  expect(cat).not.toBeVisible();
  expect(screen.queryByRole('button', { name: 'Hide image' })).not.toBeInTheDocument();
  expect(screen.getByText(':party:')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Show images' }));

  expect(cat).toHaveAttribute('src', 'https://example.org/cat.png');
  expect(cat).toBeVisible();
  expect(screen.getByRole('button', { name: 'Hide image' })).toBeInTheDocument();
  expect(screen.queryByText(':party:')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show images' })).not.toBeInTheDocument();
  mediaPreviewSettings.global = {};
});

test('enabling all rooms reveals inline images without refreshing', async () => {
  preferences.mediaAutoLoad = 'private';
  render(FormattedBodyMediaHarness, {
    props: { html: '<img src="https://example.org/cat.png" alt="cat">', joinRule: 'public' },
  });
  await tick();

  expect(screen.getByRole('button', { name: 'Show images' })).toBeInTheDocument();
  preferences.mediaAutoLoad = 'on';
  await tick();
  expect(screen.getByRole('img', { name: 'cat' })).toHaveAttribute(
    'src',
    'https://example.org/cat.png'
  );
  expect(screen.queryByRole('button', { name: 'Show images' })).not.toBeInTheDocument();
  mediaPreviewSettings.global = {};
});

test.each([
  ['a block with no language', '<pre><code>const a = 1;</code></pre>'],
  [
    'a block over the size limit',
    `<pre><code class="language-js">${'a'.repeat(20_001)}</code></pre>`,
  ],
])('%s is left unhighlighted', async (_name, html) => {
  render(FormattedBody, { props: { html } });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(document.querySelector('pre code')?.querySelector('span')).toBeNull();
});

test.each(['https://matrix.to/#/@ezera:example.org', 'matrix:u/ezera:example.org'])(
  'labels a user mention the same on %s',
  async (href) => {
    render(FormattedBody, { props: { html: `<a href="${href}">hello</a>` } });
    await tick();

    expect(screen.getByRole('link', { name: '@ezera' })).toHaveAttribute(
      'data-matrix-link',
      'user'
    );
  }
);
