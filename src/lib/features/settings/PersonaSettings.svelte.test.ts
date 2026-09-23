// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn<() => Promise<string>>(),
  uploadMedia: vi.fn<() => Promise<string>>(),
  save: vi.fn<(persona: PersonaView, previousId: string | null) => Promise<void>>(),
  load: vi.fn<(force?: boolean) => Promise<void>>(),
  accountData: vi.fn<(eventType: string) => Promise<unknown>>(),
  setAccountData: vi.fn<(eventType: string, content: unknown) => Promise<void>>(),
}));

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

Object.assign(core, {
  uploadMedia: mocks.uploadMedia,
  accountData: mocks.accountData,
  setAccountData: mocks.setAccountData,
});
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], loading: false, error: null, ...mocks }),
}));

import PersonaSettings from './PersonaSettings.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
  document.body.replaceChildren();
});

test.each([
  [false, false],
  [true, false],
  [true, true],
])('imports avatar with native=%s, failed=%s', async (native, failed) => {
  mocks.isTauri.mockReturnValue(native);
  mocks.invoke.mockResolvedValue('mxc://example.org/avatar');
  if (failed) mocks.invoke.mockRejectedValue(new Error('Download unavailable'));
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const avatar = 'https://cdn.pluralkit.me/member.png';
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
    if (url === avatar) {
      if (native) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'image/png' } }));
    }
    return Promise.resolve(Response.json([{ id: 'abcde', name: 'Member', avatar_url: avatar }]));
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.uploadMedia.mockResolvedValue('mxc://example.org/avatar');
  mocks.save.mockResolvedValue();
  mocks.load.mockResolvedValue();

  const instance = mount(PersonaSettings, { target: document.body });
  try {
    const input = document.querySelector<HTMLInputElement>('.import-form input');
    if (!input) throw new Error('Missing system input');
    input.value = 'system';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    const form = document.querySelector<HTMLFormElement>('.import-form');
    if (!form) throw new Error('Missing import form');
    form.requestSubmit();

    await vi.waitFor(() => {
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({ avatar_url: failed ? null : 'mxc://example.org/avatar' }),
        null
      );
    });
    if (failed) {
      expect(document.querySelector('.import-form')?.textContent).toContain(
        'pictures could not be fetched'
      );
    }
    if (native) {
      expect(mocks.invoke).toHaveBeenCalledWith('import_persona_avatar', { url: avatar });
      expect(fetchMock).not.toHaveBeenCalledWith(avatar);
      expect(mocks.uploadMedia).not.toHaveBeenCalled();
    } else {
      expect(fetchMock).toHaveBeenCalledWith(avatar);
      expect(mocks.uploadMedia).toHaveBeenCalledWith('image/png', bytes);
    }
  } finally {
    await unmount(instance);
  }
});

function choose(input: HTMLInputElement | null, text: string): void {
  if (!input) throw new Error('Missing file input');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([text], 'export.json', { type: 'application/json' })],
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('imports the members of a PluralKit export file', async () => {
  mocks.save.mockResolvedValue();
  mocks.load.mockResolvedValue();
  const instance = mount(PersonaSettings, { target: document.body });
  try {
    choose(
      document.querySelector('.import-form input[type="file"]'),
      JSON.stringify({ members: [{ id: 'abcde', name: 'Member', proxy_tags: [{ prefix: 'm:' }] }] })
    );

    await vi.waitFor(() => {
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'Member',
          triggers: [expect.objectContaining({ prefix: 'm:' })],
        }),
        null
      );
    });
    expect(document.querySelector('.import-form')?.textContent).toContain('Imported 1 members.');
  } finally {
    await unmount(instance);
  }
});

test('reports an export file that holds no members', async () => {
  mocks.load.mockResolvedValue();
  const instance = mount(PersonaSettings, { target: document.body });
  try {
    choose(document.querySelector('.import-form input[type="file"]'), '{"id":"abcde"}');

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('That file could not be imported.');
    });
    expect(mocks.save).not.toHaveBeenCalled();
  } finally {
    await unmount(instance);
  }
});

test('restores a backup only after confirmation', async () => {
  mocks.load.mockResolvedValue();
  mocks.setAccountData.mockResolvedValue();
  const catalog = { profiles: [{ id: 'kris' }] };
  const instance = mount(PersonaSettings, { target: document.body });
  try {
    const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    choose(input, JSON.stringify({ 'fi.mau.msc4461.per_message_profiles.v3': catalog }));

    await vi.waitFor(() => {
      expect(document.querySelector('.confirm')).not.toBeNull();
    });
    expect(mocks.setAccountData).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('.confirm .btn-danger')?.click();
    await vi.waitFor(() => {
      expect(mocks.load).toHaveBeenCalledWith(true);
    });
    expect(mocks.setAccountData).toHaveBeenCalledWith(
      'fi.mau.msc4461.per_message_profiles.v3',
      catalog
    );
  } finally {
    await unmount(instance);
  }
});

test('rejects a backup without the v3 catalog', async () => {
  mocks.load.mockResolvedValue();
  const instance = mount(PersonaSettings, { target: document.body });
  try {
    const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    choose(input, JSON.stringify({ 'fi.mau.msc4461.per_message_profiles.v2': { profiles: [] } }));

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('not a per-message profile backup');
    });
    expect(document.querySelector('.confirm')).toBeNull();
    expect(mocks.setAccountData).not.toHaveBeenCalled();
  } finally {
    await unmount(instance);
  }
});
