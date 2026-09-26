// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import ProfileCard from './ProfileCard.svelte';

test('Enter in a field continues, and a save error is shown in the status line', async () => {
  const user = userEvent.setup();
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
  render(ProfileCard, props);

  await user.type(screen.getByRole('textbox', { name: 'Display name' }), '{Enter}');

  expect(onContinue).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
});
