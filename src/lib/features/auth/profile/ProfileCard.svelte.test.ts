// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import ProfileCard from './ProfileCard.svelte';

test('Enter in a field continues, and a save error is shown in the status line', async () => {
  const onContinue = vi.fn();
  const props = {
    userId: '@new:example.org',
    displayName: 'New',
    pronouns: '',
    nameColor: '',
    status: '',
    bannerPreview: null,
    avatarPreview: null,
    isSaving: false,
    error: 'Could not save',
    onDisplayName: vi.fn(),
    onPronouns: vi.fn(),
    onNameColor: vi.fn(),
    onStatus: vi.fn(),
    onBanner: vi.fn(),
    onAvatar: vi.fn(),
    onContinue,
    onSkip: vi.fn(),
  };
  const instance = mount(ProfileCard, { target: document.body, props });
  flushSync();

  document.querySelector('form')?.requestSubmit();
  expect(onContinue).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save');

  await unmount(instance);
  document.body.replaceChildren();
});
