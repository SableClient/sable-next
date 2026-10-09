// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';
import { core } from '#lib/core/__mocks__/context.js';

import ProfileEditor from './ProfileEditor.svelte';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], byId: () => undefined }),
}));

const profile: ProfileView = {
  user_id: '@me:example.org',
  display_name: 'Me',
  avatar_url: null,
  bio: null,
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [{ summary: 'they/them', language: null }],
  timezone: null,
  name_color_light: null,
  name_color_dark: null,
  animal: null,
  extra: [],
  supporter_awards: null,
  legacy_fields: [],
};

const setProfileField = vi.fn<(field: string, value: unknown) => Promise<void>>(() =>
  Promise.resolve()
);
const setDisplayName = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(core, { setProfileField, setDisplayName });
});

function mount(onSaved = vi.fn()) {
  render(ProfileEditor, { profile, userId: profile.user_id, onSaved });
  return onSaved;
}

test('starts clean and enables Save only once something changes', async () => {
  const user = userEvent.setup();
  mount();

  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  await user.type(screen.getByLabelText('Display name'), '!');
  expect(save).toBeEnabled();
});

test('Cancel puts every field back', async () => {
  const user = userEvent.setup();
  mount();

  await user.type(screen.getByLabelText('Display name'), '!');
  await user.clear(screen.getByLabelText('Pronouns'));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.getByLabelText('Display name')).toHaveValue('Me');
  expect(screen.getByLabelText('Pronouns')).toHaveValue('they/them');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(setProfileField).not.toHaveBeenCalled();
});

test('Save writes only what changed', async () => {
  const user = userEvent.setup();
  const onSaved = mount();

  await user.clear(screen.getByLabelText('Pronouns'));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await vi.waitFor(() => {
    expect(onSaved).toHaveBeenCalled();
  });
  expect(setDisplayName).not.toHaveBeenCalled();
  expect(setProfileField.mock.calls).toEqual([['io.fsky.nyx.pronouns', []]]);
});

test('offers a profile scope beside the tabs', () => {
  mount();

  expect(screen.getByLabelText('Profile for')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
});

test('the avatar picture opens the avatar file picker', async () => {
  const user = userEvent.setup();
  mount();

  const input = document.querySelector<HTMLInputElement>('.file-button input[type="file"]');
  const open = vi.spyOn(input as HTMLInputElement, 'click');
  await user.click(screen.getByRole('button', { name: 'Upload avatar' }));

  expect(open).toHaveBeenCalledOnce();
});

test('a drag that starts on the card is cancelled so it cannot drop into a field', () => {
  mount();

  const cover = document.querySelector('.profile-card-cover') as HTMLElement;
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  cover.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
});
