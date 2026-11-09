import { afterEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import type { ImagePackView } from '#src/generated/protocol';
import Harness from './BioEditorHarness.test.svelte';

const packs: ImagePackView[] = [
  {
    id: 'personal',
    name: 'Personal',
    avatar_url: null,
    attribution: null,
    usage: ['emoticon'],
    origin: 'account',
    room_id: null,
    declared_name: 'Personal',
    declared_avatar_url: null,
    stable_event: false,
    legacy_event: true,
    images: [
      {
        shortcode: 'biowave',
        body: 'Wave',
        url: 'mxc://example.org/biowave',
        usage: ['emoticon'],
        source_pack: null,
        info: null,
      },
    ],
  },
];

function client(): CoreClient {
  const core = {
    session: null,
    subscribeEvents: () => () => {},
    fetchMedia: () =>
      Promise.resolve(
        Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYFvXsPwAGNgLW0emd+QAAAABJRU5ErkJggg=='
          ),
          (char) => char.charCodeAt(0)
        )
      ),
    rpc: {
      packs: { listAll: () => Promise.resolve(packs) },
      messages: {
        frequentReactions: () => Promise.resolve([]),
        rememberEmoji: () => Promise.resolve(null),
        reactionShortcodes: () => Promise.resolve([]),
      },
    },
  };
  return { ...core, media: core } as unknown as CoreClient;
}

afterEach(() => {
  setPreference('richTextComposer', true);
  setPreference('enterForNewline', 'adaptive');
});

async function mount(html = '') {
  const screen = await render(Harness, { core: client(), html });
  const editor = screen.getByRole('combobox', { name: 'Biography' });
  const content = () =>
    JSON.parse(document.querySelector('output')?.textContent ?? '{}') as {
      body: string;
      formatted: string | null;
    };
  return { screen, editor, content };
}

test('renders saved inline images and preserves them after editing and reset', async () => {
  const { screen, editor, content } = await mount(
    '<p>Hello <img data-mx-emoticon src="mxc://example.org/wave" alt=":wave:"> <img src="mxc://example.org/cat" alt="Cat"></p>'
  );
  await expect.element(editor.getByRole('img', { name: ':wave:' })).toBeVisible();
  await expect.element(editor.getByRole('img', { name: 'Cat', exact: true })).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard('{End} edited');
  await expect.poll(() => content().body).toContain('edited');
  expect(content().formatted).toContain('mxc://example.org/wave');
  expect(content().formatted).toContain('mxc://example.org/cat');
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await expect.poll(() => content().body).not.toContain('edited');
  await expect.element(editor.getByRole('img', { name: ':wave:' })).toBeVisible();
});

test('autocomplete inserts custom emoji and can be dismissed and reopened', async () => {
  const { editor, content } = await mount();
  await userEvent.click(editor);
  await userEvent.keyboard(':biow');
  await expect
    .element(page.getByRole('option', { name: ':biowave: Wave · Personal' }))
    .toBeVisible();
  await expect.element(editor).toHaveAttribute('aria-expanded', 'true');
  await userEvent.keyboard('{Escape}');
  await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
  await userEvent.keyboard('a');
  await expect.element(page.getByRole('listbox')).toBeVisible();
  await userEvent.click(page.getByRole('option', { name: ':biowave: Wave · Personal' }));
  await expect.element(editor.getByRole('img', { name: 'Wave', exact: true })).toBeVisible();
  expect(content().formatted).toContain('mxc://example.org/biowave');
});

test('unicode autocomplete works and Enter and Shift+Enter keep editing the bio', async () => {
  setPreference('richTextComposer', false);
  setPreference('enterForNewline', 'send');
  const { editor, content } = await mount();
  await userEvent.click(editor);
  await userEvent.keyboard(':smile');
  await expect.element(page.getByRole('listbox')).toBeVisible();
  await userEvent.keyboard('{Tab}');
  await expect.poll(() => content().body).toMatch(/\p{Extended_Pictographic}/u);
  await userEvent.keyboard('{Enter}second{Shift>}{Enter}{/Shift}third');
  await expect.poll(() => content().body).toContain('second\nthird');
});

for (const width of [390, 1280]) {
  test(`the emoji selector at ${String(width)}px has a background and inserts an emote`, async () => {
    await page.viewport(width, 844);
    const { screen, editor, content } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Emotes', exact: true }));
    if (width >= 768) {
      const picker = document.querySelector('.profile-emote-picker');
      expect(picker).not.toBeNull();
      expect(getComputedStyle(picker as Element).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    } else {
      await expect.element(page.getByRole('dialog')).toBeVisible();
    }
    await userEvent.fill(
      page.getByRole('searchbox', { name: 'Search emoji and emotes' }),
      'biowave'
    );
    await userEvent.click(page.getByRole('button', { name: ':biowave:', exact: true }));
    await expect.element(editor.getByRole('img', { name: 'Wave', exact: true })).toBeVisible();
    expect(content().formatted).toContain('mxc://example.org/biowave');
  });
}
