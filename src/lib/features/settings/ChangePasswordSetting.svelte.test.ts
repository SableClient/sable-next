// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { OAuthMetadataView, Rpc } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/platform/external-auth.js', () => ({
  openExternalAuthUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock('#lib/platform/external-links.js', () => ({
  opensExternalUrls: vi.fn(() => false),
  openExternalUrl: vi.fn(() => Promise.resolve()),
}));
import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
import { openExternalUrl, opensExternalUrls } from '#lib/platform/external-links.js';
import { CoreError } from '#src/transport';
import ChangePasswordSetting from './ChangePasswordSetting.svelte';

const changePassword = vi.fn<Rpc['account']['changePassword']>();
const passwordChangeEnabled = vi.fn<Rpc['account']['passwordChangeEnabled']>();
Object.assign(baseCore, { rpc: { account: { changePassword, passwordChangeEnabled } } });

beforeEach(() => {
  changePassword.mockReset().mockResolvedValue(null);
  passwordChangeEnabled.mockReset().mockResolvedValue(true);
  Object.assign(baseCore, { oauthMetadata: null });
});

async function fill(current: string, next: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  return user;
}

test('a confirmation that differs from the new password blocks the request', async () => {
  render(ChangePasswordSetting);
  await fill('old', 'new secret', 'other');

  expect(changePassword).not.toHaveBeenCalled();
  const confirm = screen.getByLabelText('Confirm new password');
  expect(confirm).toHaveAccessibleDescription('Passwords do not match.');
});

test('a wrong current password is reported on the current password field', async () => {
  changePassword.mockRejectedValue(new CoreError({ code: 'denied' }));
  render(ChangePasswordSetting);
  await fill('wrong', 'new secret', 'new secret');

  expect(screen.getByLabelText('Current password')).toHaveAccessibleDescription(
    'The current password was not accepted.'
  );
});

test('a success clears the passwords and leaves other devices signed in by default', async () => {
  render(ChangePasswordSetting);
  await fill('old', 'new secret', 'new secret');

  expect(changePassword).toHaveBeenCalledWith({
    current_password: 'old',
    new_password: 'new secret',
    logout_devices: false,
  });
  expect(await screen.findByText('Your password was changed.')).toBeInTheDocument();
  expect(screen.getByLabelText('Current password')).toHaveValue('');
  expect(screen.getByLabelText('New password')).toHaveValue('');
});

test('a server that disables password changes shows no form', async () => {
  passwordChangeEnabled.mockResolvedValue(false);
  render(ChangePasswordSetting);

  await vi.waitFor(() => {
    expect(passwordChangeEnabled).toHaveBeenCalled();
  });
  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
});

test('an OIDC account gets the management link and no form', async () => {
  Object.assign(baseCore, {
    oauthMetadata: {
      account_management_uri: 'https://id.example.org/account',
    } as OAuthMetadataView,
  });
  render(ChangePasswordSetting);

  expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Manage password' }));
  expect(openExternalAuthUrl).toHaveBeenCalledWith('https://id.example.org/account');
  expect(passwordChangeEnabled).not.toHaveBeenCalled();
});

test('native apps manage the password in the system browser that holds the account session', async () => {
  vi.mocked(opensExternalUrls).mockReturnValue(true);
  onTestFinished(() => {
    vi.mocked(opensExternalUrls).mockReturnValue(false);
  });
  vi.mocked(openExternalAuthUrl).mockClear();
  Object.assign(baseCore, {
    oauthMetadata: {
      account_management_uri: 'https://id.example.org/account',
    } as OAuthMetadataView,
  });
  render(ChangePasswordSetting);

  await userEvent.click(screen.getByRole('button', { name: 'Manage password' }));
  expect(openExternalUrl).toHaveBeenCalledWith('https://id.example.org/account');
  expect(openExternalAuthUrl).not.toHaveBeenCalled();
});
