import { expect, test } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

import {
  isCustomReaction,
  loadReactionEmotePacks,
  loadReactionShortcodes,
  reactionEmoteLabel,
  reactionShortcode,
} from './reaction-emote-label.js';

const imagePacks = [
  {
    id: 'cats',
    name: 'Cats',
    avatar_url: null,
    images: [
      {
        shortcode: 'neocat',
        url: 'mxc://example.org/neocat',
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  },
] as ImagePackView[];

test('recognises Matrix media reaction keys', () => {
  expect(isCustomReaction('mxc://example.org/neocat')).toBe(true);
  expect(isCustomReaction('👍')).toBe(false);
});

test('uses the known custom emote shortcode instead of its media URI', () => {
  expect(reactionEmoteLabel('mxc://example.org/neocat', imagePacks, 'custom emote')).toBe(
    ':neocat:'
  );
});

test('does not expose an unknown custom emote media URI', () => {
  expect(reactionEmoteLabel('mxc://remote.example/unknown', imagePacks, 'custom emote')).toBe(
    'custom emote'
  );
});

test('retries a room pack read after a transient failure', async () => {
  let attempts = 0;
  const load = (): Promise<ImagePackView[]> => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(imagePacks);
  };

  await expect(loadReactionEmotePacks('!retry:example.org', load)).rejects.toThrow('offline');
  await expect(loadReactionEmotePacks('!retry:example.org', load)).resolves.toBe(imagePacks);
  expect(attempts).toBe(2);
});

test('prefers the shortcode the reaction was sent with over the local pack name', () => {
  const sent = new Map([['mxc://example.org/neocat', 'partycat']]);

  expect(reactionEmoteLabel('mxc://example.org/neocat', imagePacks, 'custom emote', sent)).toBe(
    ':partycat:'
  );
  expect(reactionShortcode('mxc://example.org/neocat', imagePacks, sent)).toBe(':partycat:');
});

test('names an image from another pack by the shortcode it was sent with', () => {
  const sent = new Map([['mxc://remote.example/parrot', 'partyparrot']]);

  expect(reactionEmoteLabel('mxc://remote.example/parrot', imagePacks, 'custom emote', sent)).toBe(
    ':partyparrot:'
  );
});

test('has no shortcode to fall back on for an unknown image', () => {
  expect(reactionShortcode('mxc://remote.example/unknown', imagePacks, new Map())).toBeNull();
  expect(reactionShortcode('👍', imagePacks, new Map())).toBeNull();
});

test('asks the core for sent shortcodes once per message and set of custom keys', async () => {
  let calls = 0;
  const fetch = () => {
    calls += 1;
    return Promise.resolve([{ key: 'mxc://remote.example/parrot', shortcode: 'partyparrot' }]);
  };

  const first = await loadReactionShortcodes(
    '!r:example.org',
    '$e',
    ['mxc://remote.example/parrot'],
    fetch
  );
  await loadReactionShortcodes('!r:example.org', '$e', ['mxc://remote.example/parrot'], fetch);
  expect(first.get('mxc://remote.example/parrot')).toBe('partyparrot');
  expect(calls).toBe(1);

  await loadReactionShortcodes(
    '!r:example.org',
    '$e',
    ['mxc://remote.example/parrot', 'mxc://remote.example/cat'],
    fetch
  );
  expect(calls).toBe(2);
});
