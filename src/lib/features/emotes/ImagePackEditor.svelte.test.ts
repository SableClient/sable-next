// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  uploadMedia: vi.fn<() => Promise<string>>(),
}));

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { core } from '#lib/core/__mocks__/context.js';

Object.assign(core, { uploadMedia: mocks.uploadMedia });

import ImagePackEditor from './ImagePackEditor.svelte';
import { packEventContent, type PackDraft } from './pack-content.js';
import { beforeNavigate } from '#lib/test-support/app-navigation.js';
import { leaveUnlessUnsaved } from '#lib/ui/unsaved-guard.js';

function pack(usage: ImagePackView['usage']): ImagePackView {
  return {
    id: 'stickers',
    origin: 'room',
    room_id: '!r:example.org',
    name: 'Stickers',
    avatar_url: null,
    declared_name: 'Stickers',
    declared_avatar_url: null,
    attribution: null,
    usage,
    stable_event: true,
    legacy_event: false,
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

const button = (name: string) => screen.getByRole('button', { name });

function imageInput(): HTMLInputElement {
  const input = document.querySelector('input[accept="image/*"][multiple]');
  if (!(input instanceof HTMLInputElement)) throw new Error('the image input was not found');
  return input;
}

async function pickImage(): Promise<void> {
  // The test bytes are not a real image, and dimension reading is irrelevant here.
  vi.stubGlobal('createImageBitmap', undefined);
  await userEvent.upload(
    imageInput(),
    new File([new Uint8Array([1])], 'party.png', { type: 'image/png' })
  );
  await vi.waitFor(() => {
    expect(button('Upload')).toBeEnabled();
  });
}

async function appliedDraft(applied: PackDraft[]): Promise<PackDraft> {
  await userEvent.click(button('Apply changes'));
  if (applied.length === 0) throw new Error('the draft was never applied');
  return applied[0];
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test('an image uploaded to a sticker-only pack follows the pack usage', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/party');
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

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
});

test('a mixed pack keeps uploaded images serving both tabs', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/party');
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['emoticon', 'sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  await pickImage();
  const draft = await appliedDraft(applied);

  const images = packEventContent(draft).images as Record<string, Record<string, unknown>>;
  expect(images.party.usage).toBeUndefined();
});

test('a new pack picture is saved as soon as it uploads', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/icon');
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  const input = document.querySelector('input[accept="image/*"]:not([multiple])');
  if (!(input instanceof HTMLInputElement)) throw new Error('the picture input was not found');
  await userEvent.upload(input, new File([new Uint8Array([1])], 'icon.png', { type: 'image/png' }));
  await vi.waitFor(() => {
    expect(applied).toHaveLength(1);
  });

  expect(applied[0].avatarUrl).toBe('mxc://example.org/icon');
  expect(applied[0].images.map((image) => image.shortcode)).toEqual(['wave']);
  expect(button('Apply changes')).toBeDisabled();
});

test('pressing Enter in the shortcode field saves the rename', async () => {
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  await userEvent.click(screen.getByRole('button', { name: /rename/i }));
  const [input] = screen.getAllByRole('textbox', { name: 'Shortcode' });
  await userEvent.clear(input);
  await userEvent.type(input, 'hello{Enter}');

  await vi.waitFor(() => {
    expect(applied).toHaveLength(1);
  });
  expect(applied[0].images.map((image) => image.shortcode)).toEqual(['hello']);
});

test('an image can be switched from sticker to emoji and saved', async () => {
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['emoticon', 'sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  const group = screen.getByRole('radiogroup', { name: 'Where :wave: can be used' });
  await userEvent.click(within(group).getByLabelText('Emoji'));
  const draft = await appliedDraft(applied);

  expect(draft.images[0].usage).toEqual(['emoticon']);
});

test('an upload never writes the room avatar or name into the pack', async () => {
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/party');
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: {
        ...pack(['sticker']),
        name: 'Room',
        avatar_url: 'mxc://example.org/room',
        declared_name: null,
      },
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  await pickImage();
  const content = packEventContent(await appliedDraft(applied));

  expect(content.pack).toEqual({
    display_name: undefined,
    avatar_url: undefined,
    attribution: undefined,
    usage: ['sticker'],
  });
});

test('an attribution keeps its line breaks', async () => {
  const applied: PackDraft[] = [];
  render(ImagePackEditor, {
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });

  await userEvent.type(
    screen.getByRole('textbox', { name: 'Attribution' }),
    'Art by A{Enter}CC BY'
  );
  const draft = await appliedDraft(applied);

  expect(draft.attribution).toBe('Art by A\nCC BY');
});

function renderDirtyEditor(applied: PackDraft[]): void {
  render(ImagePackEditor, {
    props: {
      pack: pack(['sticker']),
      canEdit: true,
      onApply: (draft: PackDraft) => {
        applied.push(draft);
        return Promise.resolve();
      },
    },
  });
}

test('leaving with nothing edited goes straight through', () => {
  renderDirtyEditor([]);
  const proceed = vi.fn();

  leaveUnlessUnsaved(proceed);

  expect(proceed).toHaveBeenCalledOnce();
});

test('leaving with unsaved edits asks first, and Keep editing stays', async () => {
  renderDirtyEditor([]);
  await userEvent.type(screen.getByRole('textbox', { name: 'Attribution' }), 'x');
  const proceed = vi.fn();

  leaveUnlessUnsaved(proceed);
  await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));

  expect(proceed).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();
  expect(button('Apply changes')).toBeEnabled();
});

test('Discard leaves without saving', async () => {
  const applied: PackDraft[] = [];
  renderDirtyEditor(applied);
  await userEvent.type(screen.getByRole('textbox', { name: 'Attribution' }), 'x');
  const proceed = vi.fn();

  leaveUnlessUnsaved(proceed);
  await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));

  expect(proceed).toHaveBeenCalledOnce();
  expect(applied).toHaveLength(0);
});

test('Save writes the pack and then leaves', async () => {
  const applied: PackDraft[] = [];
  renderDirtyEditor(applied);
  await userEvent.type(screen.getByRole('textbox', { name: 'Attribution' }), 'x');
  const proceed = vi.fn();

  leaveUnlessUnsaved(proceed);
  const save = await screen.findByRole('button', { name: 'Save' });
  await userEvent.click(save);

  await vi.waitFor(() => {
    expect(proceed).toHaveBeenCalledOnce();
  });
  expect(applied.map((draft) => draft.attribution)).toEqual(['x']);
});

type NavigationHook = (navigation: {
  from: { url: URL } | null;
  to: { url: URL } | null;
  type: string;
  willUnload: boolean;
  cancel: () => void;
}) => void;

function navigate(to: string, from = 'http://localhost/rooms/a'): () => void {
  const hook = beforeNavigate.mock.calls.at(-1)?.[0] as NavigationHook;
  const cancel = vi.fn();
  hook({
    from: { url: new URL(from) },
    to: { url: new URL(to) },
    type: 'link',
    willUnload: false,
    cancel,
  });
  return cancel;
}

test('navigating to another page with unsaved edits is cancelled and asks', async () => {
  renderDirtyEditor([]);
  await userEvent.type(screen.getByRole('textbox', { name: 'Attribution' }), 'x');

  const cancel = navigate('http://localhost/rooms/b');

  expect(cancel).toHaveBeenCalledOnce();
  expect(await screen.findByRole('button', { name: 'Keep editing' })).toBeInTheDocument();
});

test('navigating with nothing edited, or within the same url, is left alone', async () => {
  renderDirtyEditor([]);
  expect(navigate('http://localhost/rooms/b')).not.toHaveBeenCalled();

  await userEvent.type(screen.getByRole('textbox', { name: 'Attribution' }), 'x');
  expect(navigate('http://localhost/rooms/a')).not.toHaveBeenCalled();
});
