// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

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

const SYSTEM_LABEL = 'System ID';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
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

  const user = userEvent.setup();
  render(PersonaSettings);
  await user.type(screen.getByRole('textbox', { name: SYSTEM_LABEL }), 'system{Enter}');

  await vi.waitFor(() => {
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ avatar_url: failed ? null : 'mxc://example.org/avatar' }),
      null
    );
  });
  if (failed) {
    expect(await screen.findByText(/pictures could not be fetched/)).toBeInTheDocument();
  }
  if (native) {
    expect(mocks.invoke).toHaveBeenCalledWith('import_persona_avatar', { url: avatar });
    expect(fetchMock).not.toHaveBeenCalledWith(avatar);
    expect(mocks.uploadMedia).not.toHaveBeenCalled();
  } else {
    expect(fetchMock).toHaveBeenCalledWith(avatar);
    expect(mocks.uploadMedia).toHaveBeenCalledWith('image/png', bytes);
  }
});

async function choose(index: number, text: string): Promise<void> {
  const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]').item(index);
  await userEvent.upload(input, new File([text], 'export.json', { type: 'application/json' }));
}

test('imports the members of a PluralKit export file', async () => {
  mocks.save.mockResolvedValue();
  mocks.load.mockResolvedValue();
  render(PersonaSettings);
  await choose(
    0,
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
  expect(await screen.findByText('Imported 1 members.')).toBeInTheDocument();
});

test('reports an export file that holds no members', async () => {
  mocks.load.mockResolvedValue();
  render(PersonaSettings);
  await choose(0, '{"id":"abcde"}');

  expect(await screen.findByText(/That file could not be imported\./)).toBeInTheDocument();
  expect(mocks.save).not.toHaveBeenCalled();
});

test('restores a backup only after confirmation', async () => {
  mocks.load.mockResolvedValue();
  mocks.setAccountData.mockResolvedValue();
  const catalog = { profiles: [{ id: 'kris' }] };
  render(PersonaSettings);
  await choose(1, JSON.stringify({ 'fi.mau.msc4461.per_message_profiles.v3': catalog }));

  const dialog = await screen.findByRole('dialog');
  expect(mocks.setAccountData).not.toHaveBeenCalled();

  const [confirm] = within(dialog)
    .getAllByRole('button')
    .filter((button) => button.classList.contains('btn-danger'));
  await userEvent.click(confirm);
  await vi.waitFor(() => {
    expect(mocks.load).toHaveBeenCalledWith(true);
  });
  expect(mocks.setAccountData).toHaveBeenCalledWith(
    'fi.mau.msc4461.per_message_profiles.v3',
    catalog
  );
});

test('rejects a backup without the v3 catalog', async () => {
  mocks.load.mockResolvedValue();
  render(PersonaSettings);
  await choose(1, JSON.stringify({ 'fi.mau.msc4461.per_message_profiles.v2': { profiles: [] } }));

  expect(await screen.findByText(/not a per-message profile backup/)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.setAccountData).not.toHaveBeenCalled();
});
