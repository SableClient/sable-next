// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { ComponentProps } from 'svelte';

import type { LoginFlowsView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import LoginForm from './LoginForm.svelte';

const flows: LoginFlowsView = {
  password: true,
  oidc: false,
  oidc_registration: false,
  qr_login: false,
  sso: false,
  oauth_aware_preferred: false,
  sso_identity_providers: [],
};

function setup(
  onValidateHomeserver: () => Promise<LoginFlowsView | null>,
  overrides: Partial<ComponentProps<typeof LoginForm>> = {}
) {
  const onLogin = vi.fn(() => Promise.resolve());
  const { rerender } = render(LoginForm, {
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
      ...overrides,
    },
  });
  return { onLogin, rerender };
}

async function enterUsername(value: string): Promise<void> {
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Username, Matrix ID or email' });
  await user.clear(input);
  await user.type(input, value);
  await user.tab();
}

const homeserver = () => screen.getByRole('combobox', { name: 'Account provider' });

test('Tab moves from username to password before password recovery', async () => {
  setup(() => Promise.resolve(flows));
  const user = userEvent.setup();
  const username = screen.getByRole('textbox', { name: 'Username, Matrix ID or email' });
  const password = screen.getByLabelText('Password', { selector: 'input' });
  const recovery = screen.getByRole('link', { name: 'Forgot password?' });

  username.focus();
  await user.tab();
  expect(password).toHaveFocus();
  await user.tab({ shift: true });
  expect(username).toHaveFocus();
  await user.tab();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
  await user.tab();
  expect(recovery).toHaveFocus();
});

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
      'We couldn’t find nowhere.invalid. Check the address or choose a provider.'
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

test('provider loading and errors update live regions without moving focus', async () => {
  const { rerender } = setup(() => Promise.resolve(flows), { loginFlows: null });
  const provider = homeserver();
  provider.focus();
  const status = screen.getByRole('status');
  const alert = screen.getByRole('alert');

  await rerender({ isCheckingHomeserver: true });
  expect(screen.getByRole('status')).toBe(status);
  expect(status).toHaveTextContent('Checking provider');
  expect(status.closest('[aria-busy="true"]')).toBeNull();
  expect(provider).toHaveFocus();

  await rerender({ isCheckingHomeserver: false, loginError: 'Could not reach provider' });
  expect(screen.getByRole('alert')).toBe(alert);
  expect(alert).toHaveTextContent('Could not reach provider');
  expect(status).toBeEmptyDOMElement();
  expect(provider).toHaveFocus();

  await rerender({ loginError: null, loginFlows: flows });
  expect(status).toBeInTheDocument();
  expect(alert).toBeEmptyDOMElement();
  expect(provider).toHaveFocus();
});

test('an empty provider has no Continue button', () => {
  setup(() => Promise.resolve(null), { homeserver: '', loginFlows: null });
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
});

test('the create-account link only shows when the caller offers it', async () => {
  const { rerender } = setup(() => Promise.resolve(flows));
  expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  await rerender({ onCreateAccount: vi.fn() });
  expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
});
