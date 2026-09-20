import { expect, test } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

import {
  isCustomReaction,
  loadReactionEmotePacks,
  reactionEmoteLabel,
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
  expect(reactionEmoteLabel('mxc://example.org/neocat', imagePacks, 'Custom emote')).toBe(
    ':neocat:'
  );
});

test('does not expose an unknown custom emote media URI', () => {
  expect(reactionEmoteLabel('mxc://remote.example/unknown', imagePacks, 'Custom emote')).toBe(
    'Custom emote'
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
