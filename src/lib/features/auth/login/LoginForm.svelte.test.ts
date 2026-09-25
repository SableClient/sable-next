// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { LoginFlowsView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import LoginForm from './LoginForm.svelte';

const flows: LoginFlowsView = {
  password: true,
  oidc: false,
  oidc_registration: false,
  sso: false,
  oauth_aware_preferred: false,
  sso_identity_providers: [],
};

function render(onValidateHomeserver: () => Promise<LoginFlowsView | null>) {
  const onLogin = vi.fn(() => Promise.resolve());
  const instance = mount(LoginForm, {
    target: document.body,
    props: {
      homeserver: 'matrix.org',
      loginFlows: flows,
      invalidField: null,
      fieldError: null,
      loginError: null,
      isCheckingHomeserver: false,
      isLaunchingLogin: false,
      onClearHomeserverValidation: vi.fn(),
      onValidateHomeserver,
      onClearFieldError: vi.fn(),
      onLaunchRedirectLogin: vi.fn(() => Promise.resolve()),
      onLogin,
    },
  });
  return { instance, onLogin };
}

function enterUsername(value: string): void {
  const input = document.querySelector<HTMLInputElement>('#username');
  if (!input) throw new Error('missing username');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  flushSync();
}

const homeserverValue = () => document.querySelector<HTMLInputElement>('#homeserver')?.value;

afterEach(() => {
  document.body.replaceChildren();
});

test('a full Matrix ID moves the provider to its server and says so', async () => {
  const validate = vi.fn(() => Promise.resolve(flows));
  const { instance } = render(validate);

  enterUsername('@alice:example.org');

  expect(homeserverValue()).toBe('example.org');
  expect(validate).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain('Signing in on example.org');
  });

  await unmount(instance);
});

test('a server that cannot be found puts the provider back and explains', async () => {
  const { instance, onLogin } = render(() => Promise.resolve(null));

  enterUsername('@alice:nowhere.invalid');

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(
      "We couldn't find nowhere.invalid. Check the address or choose a provider."
    );
  });
  expect(homeserverValue()).toBe('matrix.org');
  expect(onLogin).not.toHaveBeenCalled();

  await unmount(instance);
});

test('a localpart or an email leaves the provider alone', async () => {
  const validate = vi.fn(() => Promise.resolve(flows));
  const { instance } = render(validate);

  enterUsername('alice');
  enterUsername('alice@example.org');

  expect(homeserverValue()).toBe('matrix.org');
  expect(validate).not.toHaveBeenCalled();

  await unmount(instance);
});
