import { describe, expect, it, vi } from 'vitest';
import type { LoginFlowsView } from '#src/generated/protocol';
import { CoreError } from '#src/transport';
import en from '../../../../locales/en.json' with { type: 'json' };
import {
  ResetPasswordController,
  passwordResetError,
  passwordResetFieldForError,
} from './reset-password-controller.svelte';

function flows(overrides: Partial<LoginFlowsView> = {}): LoginFlowsView {
  return {
    password: true,
    oidc: false,
    oidc_registration: false,
    sso: false,
    oauth_aware_preferred: false,
    sso_identity_providers: [],
    ...overrides,
  };
}

function fakeCore(loginFlows: LoginFlowsView = flows()) {
  return {
    loginFlows: vi.fn(() => Promise.resolve(loginFlows)),
    requestPasswordResetEmail: vi.fn(
      (_homeserver: string, _email: string, clientSecret: string | null) =>
        Promise.resolve({ clientSecret: clientSecret ?? 'secret-1', sid: 'sid-1' })
    ),
    resetPassword: vi.fn(() => Promise.resolve()),
  };
}

function filled(controller: ResetPasswordController): ResetPasswordController {
  controller.setField('email', 'alice@example.org');
  controller.setField('password', 'correct horse');
  controller.setField('confirmPassword', 'correct horse');
  return controller;
}

describe('password reset controller', () => {
  it('offers no reset on a server that delegates to OAuth', async () => {
    const controller = new ResetPasswordController(
      fakeCore(flows({ oidc: true, oauth_aware_preferred: true })),
      'example.org'
    );
    await controller.checkHomeserver();
    expect(controller.step).toBe('unavailable');
  });

  it('checks the new password before sending the email', async () => {
    const core = fakeCore();
    const controller = filled(new ResetPasswordController(core, 'example.org'));
    controller.setField('confirmPassword', 'different');

    await controller.submit();

    expect(controller.invalidField).toBe('confirmPassword');
    expect(controller.fieldError).toBe(en.auth.passwordsDoNotMatch);
    expect(core.requestPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('sends the email, then resets with the same secret and session id', async () => {
    const core = fakeCore();
    const controller = filled(new ResetPasswordController(core, 'example.org'));
    controller.logoutDevices = false;

    await controller.submit();
    expect(controller.step).toBe('email-sent');
    expect(controller.sentTo).toBe('alice@example.org');

    await controller.resend();
    expect(core.requestPasswordResetEmail).toHaveBeenLastCalledWith(
      'example.org',
      'alice@example.org',
      'secret-1',
      2
    );

    await controller.confirm();
    expect(core.resetPassword).toHaveBeenCalledWith(
      'example.org',
      'secret-1',
      'sid-1',
      'correct horse',
      false
    );
    expect(controller.step).toBe('complete');
    expect(controller.password).toBe('');
  });

  it('keeps the user on the email step until the link is opened', async () => {
    const core = fakeCore();
    core.resetPassword.mockRejectedValueOnce(new CoreError({ code: 'email_verification_failed' }));
    const controller = filled(new ResetPasswordController(core, 'example.org'));

    await controller.submit();
    await controller.confirm();

    expect(controller.step).toBe('email-sent');
    expect(controller.error).toBe(en.errors.resetPasswordEmailNotConfirmed);

    await controller.confirm();
    expect(controller.step).toBe('complete');
  });

  it('returns a weak password to the form without sending another email', async () => {
    const core = fakeCore();
    core.resetPassword.mockRejectedValueOnce(new CoreError({ code: 'weak_password' }));
    const controller = filled(new ResetPasswordController(core, 'example.org'));

    await controller.submit();
    await controller.confirm();
    expect(controller.step).toBe('form');
    expect(controller.invalidField).toBe('password');

    controller.setField('password', 'a much longer passphrase');
    controller.setField('confirmPassword', 'a much longer passphrase');
    await controller.submit();

    expect(core.requestPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(core.resetPassword).toHaveBeenLastCalledWith(
      'example.org',
      'secret-1',
      'sid-1',
      'a much longer passphrase',
      true
    );
    expect(controller.step).toBe('complete');
  });

  it('starts a new session for a different address', async () => {
    const core = fakeCore();
    const controller = filled(new ResetPasswordController(core, 'example.org'));

    await controller.submit();
    controller.startOver();
    controller.setField('email', 'bob@example.org');
    await controller.submit();

    expect(core.requestPasswordResetEmail).toHaveBeenLastCalledWith(
      'example.org',
      'bob@example.org',
      null,
      1
    );
  });

  it('maps server refusals to the field or message they concern', () => {
    expect(passwordResetFieldForError(new CoreError({ code: 'unknown_email' }))).toBe('email');
    expect(passwordResetFieldForError(new CoreError({ code: 'weak_password' }))).toBe('password');
    expect(passwordResetFieldForError(new CoreError({ code: 'unsupported' }))).toBeNull();
    expect(passwordResetError(new CoreError({ code: 'unsupported' }))).toBe(
      en.errors.resetPasswordUnsupported
    );
    expect(passwordResetError(new Error('offline'))).toBe(en.errors.connectionError);
  });
});
