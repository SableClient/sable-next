import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { isHevcVideo } from './video-codec';

const fixture = (name: string) =>
  new File([readFileSync(new URL(`../features/composer/fixtures/${name}`, import.meta.url))], name);

it('reads the codec of the video track', async () => {
  expect(await isHevcVideo(fixture('hevc.mov'))).toBe(true);
  expect(await isHevcVideo(fixture('h264.mp4'))).toBe(false);
  expect(await isHevcVideo(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png'))).toBe(
    false
  );
});
