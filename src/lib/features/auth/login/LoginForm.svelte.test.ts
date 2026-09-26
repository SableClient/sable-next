// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

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

function setup(onValidateHomeserver: () => Promise<LoginFlowsView | null>) {
  const onLogin = vi.fn(() => Promise.resolve());
  render(LoginForm, {
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
  return { onLogin };
}

async function enterUsername(value: string): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Username, Matrix ID or email' });
  await user.clear(input);
  await user.type(input, value);
  await user.tab();
}

const homeserver = () => screen.getByRole('combobox', { name: 'Account provider' });

test('a full Matrix ID moves the provider to its server and says so', async () => {
  const validate = vi.fn(() => Promise.resolve(flows));
  setup(validate);

  await enterUsername('@alice:example.org');

  expect(homeserver()).toHaveValue('example.org');
  expect(validate).toHaveBeenCalledOnce();
  expect(await screen.findByText(/Signing in on example\.org/)).toBeInTheDocument();
});

test('a server that cannot be found puts the provider back and explains', async () => {
  const { onLogin } = setup(() => Promise.resolve(null));

  await enterUsername('@alice:nowhere.invalid');

  expect(
    await screen.findByText(
      "We couldn't find nowhere.invalid. Check the address or choose a provider."
    )
  ).toBeInTheDocument();
  expect(homeserver()).toHaveValue('matrix.org');
  expect(onLogin).not.toHaveBeenCalled();
});

test('a localpart or an email leaves the provider alone', async () => {
  const validate = vi.fn(() => Promise.resolve(flows));
  setup(validate);

  await enterUsername('alice');
  await enterUsername('alice@example.org');

  expect(homeserver()).toHaveValue('matrix.org');
  expect(validate).not.toHaveBeenCalled();
});
