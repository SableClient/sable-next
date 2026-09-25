// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { ProfileController } from './profile-controller.svelte';

function controller() {
  const core = {
    commands: {
      setDisplayName: vi.fn(() => Promise.resolve()),
      uploadMedia: vi.fn(() => Promise.resolve('mxc://example.org/banner')),
    },
    setProfileField: vi.fn(() => Promise.resolve()),
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
