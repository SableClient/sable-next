// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import LegacyRegistrationForm from './LegacyRegistrationForm.svelte';

function render(serverLabel: string, username: string) {
  const instance = mount(LegacyRegistrationForm, {
    target: document.body,
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
  flushSync();
  return instance;
}

const hint = () => document.querySelector('.address-hint')?.textContent.trim();

afterEach(() => {
  document.body.replaceChildren();
});

test('shows the address a username becomes on a named server', async () => {
  const instance = render('matrix.org', 'Erwan');

  expect(hint()).toContain('@Erwan:matrix.org');
  expect(
    document.querySelector('#registration-username')?.getAttribute('aria-describedby')
  ).toContain('-address');

  await unmount(instance);
});

test('does not invent a domain for a server entered as a URL', async () => {
  const instance = render('https://matrix-client.example.org', 'erwan');

  expect(hint()).not.toContain('@erwan');
  expect(hint()).toContain('becomes your Matrix address');

  await unmount(instance);
});
