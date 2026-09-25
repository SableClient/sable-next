// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { ProfileController } from './profile-controller.svelte';

function controller() {
  const core = {
    commands: { setDisplayName: vi.fn(() => Promise.resolve()) },
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
