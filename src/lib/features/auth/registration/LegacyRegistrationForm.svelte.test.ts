// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import LegacyRegistrationForm from './LegacyRegistrationForm.svelte';

function setup(serverLabel: string, username: string) {
  render(LegacyRegistrationForm, {
    props: {
      serverLabel,
      registrationToken: null,
      isRegistering: false,
      isCheckingHomeserver: false,
      username,
      registrationEmail: '',
      password: '',
      confirmPassword: '',
      emailRequirement: 'unavailable',
      tokenRequirement: 'unavailable',
      invalidField: null,
      fieldError: null,
      onRegistrationTokenInput: vi.fn(),
      onClearFieldError: vi.fn(),
      onStartRegistration: vi.fn(),
      onUsernameInput: vi.fn(),
      onRegistrationEmailInput: vi.fn(),
      onPasswordInput: vi.fn(),
      onConfirmPasswordInput: vi.fn(),
    },
  });
}

const username = () => screen.getByRole('textbox', { name: 'Username' });

test('shows the address a username becomes on a named server', () => {
  setup('matrix.org', 'Erwan');

  expect(username()).toHaveAccessibleDescription(/@Erwan:matrix\.org/);
});

test('does not invent a domain for a server entered as a URL', () => {
  setup('https://matrix-client.example.org', 'erwan');

  expect(username()).not.toHaveAccessibleDescription(/@erwan/);
  expect(username()).toHaveAccessibleDescription(/becomes your Matrix address/);
});
