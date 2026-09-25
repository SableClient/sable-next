// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  uploadMedia: vi.fn<() => Promise<string>>(),
}));

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

Object.assign(core, { uploadMedia: mocks.uploadMedia });

import ImagePackEditor from './ImagePackEditor.svelte';
import { packEventContent, type PackDraft } from './pack-content.js';

function pack(usage: ImagePackView['usage']): ImagePackView {
  return {
    id: 'stickers',
    origin: 'room',
    room_id: '!r:example.org',
    name: 'Stickers',
    avatar_url: null,
    attribution: null,
    usage,
    images: [
      {
        shortcode: 'wave',
        url: 'mxc://a/wave',
        body: null,
        usage: ['sticker'],
        info: null,
        source_pack: null,
      },
    ],
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (node) => node.textContent.trim() === label
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`the ${label} button is missing`);
  return found;
}

function imageInput(): HTMLInputElement {
  const input = document.querySelector('input[accept="image/*"][multiple]');
  if (!(input instanceof HTMLInputElement)) throw new Error('the image input was not found');
  return input;
}

async function pickImage(): Promise<void> {
  // The test bytes are not a real image, and dimension reading is irrelevant here.
  vi.stubGlobal('createImageBitmap', undefined);
  Object.defineProperty(imageInput(), 'files', {
    configurable: true,
    value: [new File([new Uint8Array([1])], 'party.png', { type: 'image/png' })],
  });
  imageInput().dispatchEvent(new Event('change', { bubbles: true }));
  for (let round = 0; round < 16; round += 1) {
    await tick();
    if (!button('Upload').disabled) return;
  }
  throw new Error('the upload never settled');
}

async function appliedDraft(applied: PackDraft[]): Promise<PackDraft> {
  button('Apply changes').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();
  if (applied.length === 0) throw new Error('the draft was never applied');
  return applied[0];
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('an image uploaded to a sticker-only pack follows the pack usage', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/party');
  const applied: PackDraft[] = [];
  const instance = mount(ImagePackEditor, {
    target: document.body,
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });
  await tick();

  await pickImage();
  const draft = await appliedDraft(applied);

  expect(draft.images.map((image) => [image.shortcode, image.usage])).toEqual([
    ['wave', ['sticker']],
    ['party', ['sticker']],
  ]);

  const content = packEventContent(draft);
  expect(content.pack).toMatchObject({ usage: ['sticker'] });
  const images = content.images as Record<string, Record<string, unknown>>;
  expect(images.party.usage).toBeUndefined();
  expect(images.party.url).toBe('mxc://example.org/party');
  expect(mocks.uploadMedia).toHaveBeenCalledWith('image/png', expect.any(Uint8Array));

  await unmount(instance);
});

test('a mixed pack keeps uploaded images serving both tabs', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/party');
  const applied: PackDraft[] = [];
  const instance = mount(ImagePackEditor, {
    target: document.body,
    props: {
      pack: pack(['emoticon', 'sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });
  await tick();

  await pickImage();
  const draft = await appliedDraft(applied);

  const images = packEventContent(draft).images as Record<string, Record<string, unknown>>;
  expect(images.party.usage).toBeUndefined();

  await unmount(instance);
});

test('a new pack picture is saved as soon as it uploads', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/icon');
  const applied: PackDraft[] = [];
  const instance = mount(ImagePackEditor, {
    target: document.body,
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });
  await tick();

  const input = document.querySelector('input[accept="image/*"]:not([multiple])');
  if (!(input instanceof HTMLInputElement)) throw new Error('the picture input was not found');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([new Uint8Array([1])], 'icon.png', { type: 'image/png' })],
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => {
    expect(applied).toHaveLength(1);
  });

  expect(applied[0].avatarUrl).toBe('mxc://example.org/icon');
  expect(applied[0].images.map((image) => image.shortcode)).toEqual(['wave']);
  expect(button('Apply changes').disabled).toBe(true);

  await unmount(instance);
});
