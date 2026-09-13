// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import type { TimelineItemContentView } from '#src/generated/protocol';

import { emoteCandidates, mergedPackContent, uploadCandidates } from './steal-emotes';
import type { PackTransferCore } from './pack-transfer';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

function message(html: string | null): TimelineItemContentView {
  return {
    kind: 'message',
    body: 'hey',
    html,
    emote: false,
    notice: false,
    edited: false,
  } as TimelineItemContentView;
}

test('an inline emote is offered with its alt as the shortcode', () => {
  const [candidate] = emoteCandidates(
    message('hey <img data-mx-emoticon src="mxc://a/wave" alt=":blob wave:" height="32">')
  );

  expect(candidate.source).toBe('mxc://a/wave');
  expect(candidate.shortcode).toBe('blob-wave');
  expect(candidate.height).toBe(32);
  expect(candidate.usage).toEqual(['emoticon']);
});

test('a plain image in a message is not an emote', () => {
  expect(emoteCandidates(message('<img src="mxc://a/photo" alt="a photo">'))).toEqual([]);
  expect(emoteCandidates(message(null))).toEqual([]);
});

test('a remote emote source is refused, so nothing offers to copy an http url', () => {
  expect(
    emoteCandidates(message('<img data-mx-emoticon src="https://evil.example/x.png" alt="x">'))
  ).toEqual([]);
});

test('the same emote twice in one message is offered once', () => {
  const candidates = emoteCandidates(
    message(
      '<img data-mx-emoticon src="mxc://a/wave" alt=":wave:"> ' +
        '<img data-mx-emoticon src="mxc://a/wave" alt=":wave:">'
    )
  );

  expect(candidates).toHaveLength(1);
});

test('an emote with no usable alt still gets a shortcode', () => {
  const [candidate] = emoteCandidates(message('<img data-mx-emoticon src="mxc://a/x" alt="!!!">'));

  expect(candidate.shortcode).toBe('emote');
});

test('a sticker is offered with sticker usage', () => {
  const [candidate] = emoteCandidates({
    kind: 'sticker',
    body: 'blobcat.png',
    source: '{"url":"mxc://a/s"}',
    mime: 'image/png',
    width: 512,
    height: 512,
  });

  expect(candidate.shortcode).toBe('blobcat');
  expect(candidate.usage).toEqual(['sticker']);
  expect(candidate.source).toBe('{"url":"mxc://a/s"}');
});

test('a candidate is re-uploaded rather than aliased to the original media', async () => {
  const core = {
    commands: {
      fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(PNG))),
      uploadMedia: vi.fn(() => Promise.resolve('mxc://mine/1')),
    },
  } as unknown as PackTransferCore;

  const [added] = await uploadCandidates(core, [
    {
      source: 'mxc://theirs/wave',
      shortcode: 'wave',
      body: 'a wave',
      width: 128,
      height: null,
      mime: null,
      usage: ['emoticon'],
    },
  ]);

  expect(vi.mocked(core.commands.fetchMedia).mock.calls[0]).toEqual(['mxc://theirs/wave', 0, 0]);
  expect(vi.mocked(core.commands.uploadMedia).mock.calls[0]?.[0]).toBe('image/png');
  expect(added.url).toBe('mxc://mine/1');
  expect(added.info).toEqual({
    width: 128,
    height: null,
    mimetype: 'image/png',
    size: PNG.length,
  });
});

test('the merge keeps the images already in the pack and everything else in the event', () => {
  const current = {
    pack: { display_name: 'Mine' },
    images: { wave: { url: 'mxc://mine/wave' } },
  };
  const next = mergedPackContent(current, [
    {
      shortcode: 'party',
      url: 'mxc://mine/party',
      body: null,
      usage: ['sticker'],
      info: null,
    },
  ]);

  expect(next.pack).toEqual({ display_name: 'Mine' });
  expect(next.images).toEqual({
    wave: { url: 'mxc://mine/wave' },
    party: { url: 'mxc://mine/party', body: undefined, usage: ['sticker'], info: undefined },
  });
});

test('a taken shortcode is suffixed rather than overwriting an emote you already have', () => {
  const next = mergedPackContent({ images: { wave: { url: 'mxc://mine/old' } } }, [
    { shortcode: 'wave', url: 'mxc://mine/new', body: null, usage: ['emoticon'], info: null },
  ]);
  const images = next.images as Record<string, { url: string } | undefined>;

  expect(images.wave?.url).toBe('mxc://mine/old');
  expect(images['wave-1']?.url).toBe('mxc://mine/new');
});

test('an empty account data event becomes a pack rather than throwing', () => {
  const next = mergedPackContent(undefined, [
    { shortcode: 'wave', url: 'mxc://mine/wave', body: null, usage: ['emoticon'], info: null },
  ]);

  expect(Object.keys(next.images as Record<string, unknown>)).toEqual(['wave']);
});
