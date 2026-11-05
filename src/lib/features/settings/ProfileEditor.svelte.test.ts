// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';
import { core } from '#lib/core/__mocks__/context.js';

import ProfileEditor from './ProfileEditor.svelte';

vi.mock('#lib/core/context.js');
vi.mock('#lib/features/room/members/MentionProfileCard.svelte', () => ({ default: () => {} }));
vi.mock('#lib/features/room/timeline/TimelineItem.svelte', () => ({ default: () => {} }));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], byId: () => undefined }),
}));

const profile: ProfileView = {
  user_id: '@me:example.org',
  display_name: 'Me',
  avatar_url: null,
  real_name: 'Me',
  real_avatar_url: null,
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
  Object.assign(core, { setProfileField });
  Object.assign(core.rpc.account, { setDisplayName });
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

test('a status over the byte limit is shown as it was saved', async () => {
  const user = userEvent.setup();
  const onSaved = mount();

  const status = screen.getByLabelText('Status');
  await user.click(status);
  await user.paste('🌴'.repeat(100));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await vi.waitFor(() => {
    expect(onSaved).toHaveBeenCalled();
  });
  expect(setProfileField).toHaveBeenCalledWith('org.matrix.msc4426.status', {
    text: '🌴'.repeat(64),
    emoji: '',
  });
  expect(status).toHaveValue('🌴'.repeat(64));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('the tabs are one tab stop that arrow keys move and select', async () => {
  const user = userEvent.setup();
  mount();
  const edit = screen.getByRole('tab', { name: 'Edit' });
  const preview = screen.getByRole('tab', { name: 'Preview' });

  expect(edit).toHaveAttribute('tabindex', '0');
  expect(preview).toHaveAttribute('tabindex', '-1');
  expect(edit).toHaveAttribute('aria-controls', 'profile-panel-edit');

  edit.focus();
  await user.keyboard('{ArrowRight}');
  expect(preview).toHaveFocus();
  expect(preview).toHaveAttribute('aria-selected', 'true');
  expect(preview).toHaveAttribute('tabindex', '0');
  expect(edit).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Preview');

  await user.keyboard('{Home}');
  expect(edit).toHaveFocus();
  expect(edit).toHaveAttribute('aria-selected', 'true');
});

test('editing and saving the bio retains custom emoji and inline image URLs', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(ProfileEditor, {
    profile: {
      ...profile,
      bio: '<p>Hello <img data-mx-emoticon src="mxc://example.org/wave" alt=":wave:"> <img src="mxc://example.org/cat" alt="Cat"></p>',
    },
    userId: profile.user_id,
    onSaved,
  });
  const bio = screen.getByRole('combobox', { name: 'Biography' });
  await user.click(bio);
  await user.paste(' cheers');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => {
    expect(onSaved).toHaveBeenCalled();
  });
  const [field, value] = setProfileField.mock.calls[0];
  expect(field).toBe('gay.fomx.biography');
  const texts = (value as { 'm.text': { body: string; mimetype?: string }[] })['m.text'];
  expect(texts).toHaveLength(2);
  expect(texts[0].mimetype).toBe('text/html');
  expect(texts[0].body).toContain('mxc://example.org/wave');
  expect(texts[0].body).toContain('mxc://example.org/cat');
  expect(texts[1].body).toContain('cheers');
});
