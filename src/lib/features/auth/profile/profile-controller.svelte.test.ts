// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { ProfileController } from './profile-controller.svelte';

function controller(existing: Partial<ProfileView> = {}) {
  const core = {
    commands: {
      setDisplayName: vi.fn(() => Promise.resolve()),
      setAvatarUrl: vi.fn(() => Promise.resolve()),
      uploadMedia: vi.fn(() => Promise.resolve('mxc://example.org/banner')),
    },
    setProfileField: vi.fn(() => Promise.resolve()),
    userProfile: vi.fn(() =>
      Promise.resolve({
        user_id: '@new:example.org',
        display_name: null,
        avatar_url: null,
        banner_url: null,
        status: null,
        pronouns: [],
        name_color_light: null,
        name_color_dark: null,
        ...existing,
      } as ProfileView)
    ),
  };
  const onNavigateHome = vi.fn(() => Promise.resolve());
  const profile = new ProfileController({
    core: core as unknown as CoreClient,
    getUserId: () => '@new:example.org',
    onNavigateHome,
  });
  return { profile, core, onNavigateHome };
}

afterEach(() => {
  localStorage.clear();
});

test('saving writes pronouns to the same profile field as Settings', async () => {
  const { profile, core, onNavigateHome } = controller();
  profile.setDisplayName('New');
  profile.setPronouns('they/them, iel (fr)');

  await profile.save();

  expect(core.setProfileField).toHaveBeenCalledWith('io.fsky.nyx.pronouns', [
    { summary: 'they/them' },
    { summary: 'iel', language: 'fr' },
  ]);
  expect(onNavigateHome).toHaveBeenCalledOnce();
});

test('no pronouns typed leaves the field alone', async () => {
  const { profile, core } = controller();

  await profile.save();

  expect(core.setProfileField).not.toHaveBeenCalled();
});

test('the extra options go to the fields Settings edits', async () => {
  const { profile, core } = controller();
  profile.setNameColor('#aa3377');
  profile.setStatus('  on holiday ');
  profile.setBanner(new File([new Uint8Array([1, 2, 3])], 'b.png', { type: 'image/png' }));

  await profile.save();

  expect(core.setProfileField).toHaveBeenCalledWith('eu.she-a.color', {
    on_light: '#aa3377',
    on_dark: '#aa3377',
  });
  expect(core.setProfileField).toHaveBeenCalledWith('m.status', { text: 'on holiday' });
  expect(core.commands.uploadMedia).toHaveBeenCalledWith('image/png', new Uint8Array([1, 2, 3]));
  expect(core.setProfileField).toHaveBeenCalledWith(
    'chat.commet.profile_banner',
    'mxc://example.org/banner'
  );
});

test('an existing profile fills the form and saving it untouched writes nothing', async () => {
  const { profile, core } = controller({
    display_name: 'Existing',
    avatar_url: 'mxc://example.org/avatar',
    banner_url: 'mxc://example.org/old-banner',
    status: { text: 'around', emoji: null },
    pronouns: [{ summary: 'she/her', language: null }],
    name_color_light: '#112233',
    name_color_dark: '#112233',
  });

  await profile.load();

  expect(profile.displayName).toBe('Existing');
  expect(profile.pronouns).toBe('she/her');
  expect(profile.nameColor).toBe('#112233');
  expect(profile.status).toBe('around');
  expect(profile.shownAvatar).toBe('mxc://example.org/avatar');
  expect(profile.shownBanner).toBe('mxc://example.org/old-banner');

  await profile.save();

  expect(core.commands.setDisplayName).not.toHaveBeenCalled();
  expect(core.commands.setAvatarUrl).not.toHaveBeenCalled();
  expect(core.setProfileField).not.toHaveBeenCalled();
});

test('clearing loaded fields removes them from the profile', async () => {
  const { profile, core } = controller({
    avatar_url: 'mxc://example.org/avatar',
    banner_url: 'mxc://example.org/old-banner',
    status: { text: 'around', emoji: null },
  });
  await profile.load();

  profile.setStatus('');
  profile.setAvatar(null);
  profile.setBanner(null);
  await profile.save();

  expect(core.setProfileField).toHaveBeenCalledWith('m.status', null);
  expect(core.setProfileField).toHaveBeenCalledWith('chat.commet.profile_banner', null);
  expect(core.commands.setAvatarUrl).toHaveBeenCalledWith(null, expect.anything());
});

test('a field typed before the profile arrives is kept', async () => {
  const { profile } = controller({ display_name: 'Existing' });
  profile.setDisplayName('Typed');

  await profile.load();

  expect(profile.displayName).toBe('Typed');
});
