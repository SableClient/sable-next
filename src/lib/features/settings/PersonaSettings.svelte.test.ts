// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn<() => Promise<string>>(),
  uploadMedia: vi.fn<() => Promise<string>>(),
  save: vi.fn<(persona: PersonaView, previousId: string | null) => Promise<void>>(),
  load: vi.fn<() => Promise<void>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => ({ commands: { uploadMedia: mocks.uploadMedia } }),
}));
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
