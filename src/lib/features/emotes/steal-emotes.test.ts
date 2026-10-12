// @vitest-environment happy-dom

import { unzipSync } from 'fflate';
import { expect, test, vi } from 'vitest';

import type { TimelineItemContentView } from '#src/generated/protocol';

import { saveBytes } from '#lib/platform/files.js';

import {
  downloadCandidates,
  emoteCandidates,
  uploadCandidates,
  type EmoteCandidate,
} from './steal-emotes';
import type { PackTransferCore } from './pack-transfer';

vi.mock('#lib/platform/files.js', () => ({
  saveBytes: vi.fn(() => Promise.resolve('saved')),
}));

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

test('an inline image is offered even though the sdk strips data-mx-emoticon', () => {
  const [candidate] = emoteCandidates(message('<img src="mxc://a/wave" alt=":wave:">'));

  expect(candidate.shortcode).toBe('wave');
});

test('a message with no html offers nothing', () => {
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

  expect(vi.mocked(core.commands.fetchMedia).mock.calls[0]).toEqual([
    'mxc://theirs/wave',
    0,
    0,
    true,
  ]);
  expect(vi.mocked(core.commands.uploadMedia).mock.calls[0]?.[0]).toBe('image/png');
  expect(added.url).toBe('mxc://mine/1');
  expect(added.info).toEqual({
    width: 128,
    height: null,
    mimetype: 'image/png',
    size: PNG.length,
  });
});

function candidate(overrides: Partial<EmoteCandidate> = {}): EmoteCandidate {
  return {
    source: 'mxc://theirs/wave',
    shortcode: 'wave',
    body: null,
    width: null,
    height: null,
    mime: null,
    usage: ['emoticon'],
    ...overrides,
  };
}

function downloadCore(): PackTransferCore {
  return {
    commands: {
      fetchMedia: vi.fn(() => Promise.resolve(new Uint8Array(PNG))),
      uploadMedia: vi.fn(() => Promise.resolve('mxc://mine/1')),
    },
  };
}

test('one emote downloads as a single image named after its shortcode', async () => {
  vi.mocked(saveBytes).mockClear();

  expect(await downloadCandidates(downloadCore(), [candidate()])).toBe('saved');

  const [bytes, filename, mime] = vi.mocked(saveBytes).mock.calls[0] ?? [];
  expect(filename).toBe('wave.png');
  expect(mime).toBe('image/png');
  expect(bytes).toEqual(PNG);
});

test('the download asks for the original, so an animated emote keeps its frames', async () => {
  const core = downloadCore();
  await downloadCandidates(core, [candidate()]);

  expect(vi.mocked(core.commands.fetchMedia).mock.calls[0]).toEqual([
    'mxc://theirs/wave',
    0,
    0,
    true,
  ]);
});

test('several emotes download as one zip, and a repeated shortcode is suffixed', async () => {
  vi.mocked(saveBytes).mockClear();

  await downloadCandidates(downloadCore(), [
    candidate(),
    candidate({ source: 'mxc://theirs/wave2' }),
  ]);

  const [bytes, filename, mime] = vi.mocked(saveBytes).mock.calls[0] ?? [];
  expect(filename).toMatch(/^sable-emotes-\d+\.zip$/u);
  expect(mime).toBe('application/zip');
  expect(Object.keys(unzipSync(bytes))).toEqual(['wave.png', 'wave-1.png']);
});
