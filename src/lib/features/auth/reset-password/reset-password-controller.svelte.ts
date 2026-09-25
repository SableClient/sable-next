import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';
import { CoreError } from '#src/transport';
import { isValidRegistrationEmail } from '#lib/features/auth/registration/registration-controller.svelte.js';

export type ResetPasswordField = 'email' | 'password' | 'confirmPassword';
export type ResetPasswordStep = 'checking' | 'unavailable' | 'form' | 'email-sent' | 'complete';

type ResetPasswordCore = Pick<
  CoreClient,
  'loginFlows' | 'requestPasswordResetEmail' | 'resetPassword'
>;

export function passwordResetError(value: unknown): string {
  if (!(value instanceof CoreError)) return t('errors.connectionError');

  switch (value.detail.code) {
    case 'invalid_email':
      return t('errors.invalidEmail');
    case 'unknown_email':
      return t('errors.resetPasswordUnknownEmail');
    case 'unsupported':
      return t('errors.resetPasswordUnsupported');
    case 'email_verification_failed':
      return t('errors.resetPasswordEmailNotConfirmed');
    case 'weak_password':
      return t('errors.weakPassword');
    case 'rate_limited':
      return value.detail.retry_after_ms
        ? t('errors.tooManyAttemptsSeconds', {
            seconds: Math.ceil(value.detail.retry_after_ms / 1000),
          })
        : t('errors.tooManyAttempts');
    case 'unavailable':
      return t('errors.temporarilyUnavailable');
    case 'unknown_homeserver':
      return t('errors.homeserverNotFound');
    default:
      return t('errors.resetPasswordFailed');
  }
}

export function passwordResetFieldForError(value: unknown): ResetPasswordField | null {
  if (!(value instanceof CoreError)) return null;
  switch (value.detail.code) {
    case 'invalid_email':
    case 'unknown_email':
      return 'email';
    case 'weak_password':
      return 'password';
    default:
      return null;
  }
}

export class ResetPasswordController {
  email = $state('');
  password = $state('');
  confirmPassword = $state('');
  logoutDevices = $state(true);
  step = $state<ResetPasswordStep>('checking');
  error = $state<string | null>(null);
  fieldError = $state<string | null>(null);
  invalidField = $state<ResetPasswordField | null>(null);
  isBusy = $state(false);
  sentTo = $state('');

  private clientSecret: string | null = null;
  private sid: string | null = null;
  private sendAttempt = 0;

  constructor(
    private readonly core: ResetPasswordCore,
    readonly homeserver: string
  ) {}

  async checkHomeserver(): Promise<void> {
    this.step = 'checking';
    this.error = null;
    try {
      const flows = await this.core.loginFlows(this.homeserver);
      this.step = flows.oidc || !flows.password ? 'unavailable' : 'form';
    } catch (value) {
      this.error = passwordResetError(value);
      this.step = 'form';
    }
  }

  setField(field: ResetPasswordField, value: string): void {
    this[field] = value;
    this.clearFieldError(field);
  }

  clearFieldError(field: ResetPasswordField): void {
    if (this.invalidField !== field) return;
    this.invalidField = null;
    this.fieldError = null;
  }

  async submit(): Promise<void> {
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;

    const email = this.email.trim();
    if (!email || !isValidRegistrationEmail(email)) {
      this.setFieldError('email', t('auth.enterEmail'));
      return;
    }
    if (!this.password) {
      this.setFieldError('password', t('auth.enterNewPassword'));
      return;
    }
    if (!this.confirmPassword) {
      this.setFieldError('confirmPassword', t('auth.enterConfirmPassword'));
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.setFieldError('confirmPassword', t('auth.passwordsDoNotMatch'));
      return;
    }

    if (this.sid && email === this.sentTo) {
      this.step = 'email-sent';
      await this.confirm();
      return;
    }
    if (email !== this.sentTo) {
      this.clientSecret = null;
      this.sid = null;
      this.sendAttempt = 0;
    }
    await this.sendEmail(email);
  }

  async resend(): Promise<void> {
    this.error = null;
    await this.sendEmail(this.sentTo);
  }

  async confirm(): Promise<void> {
    if (!this.clientSecret || !this.sid) return;
    this.isBusy = true;
    this.error = null;
    try {
      await this.core.resetPassword(
        this.homeserver,
        this.clientSecret,
        this.sid,
        this.password,
        this.logoutDevices
      );
      this.password = '';
      this.confirmPassword = '';
      this.step = 'complete';
    } catch (value) {
      const field = passwordResetFieldForError(value);
      if (field) {
        this.step = 'form';
        this.setFieldError(field, passwordResetError(value));
      } else {
        this.error = passwordResetError(value);
      }
    } finally {
      this.isBusy = false;
    }
  }

  startOver(): void {
    this.step = 'form';
    this.error = null;
    this.clientSecret = null;
    this.sid = null;
    this.sendAttempt = 0;
    this.sentTo = '';
  }

  private async sendEmail(email: string): Promise<void> {
    this.isBusy = true;
    try {
      this.sendAttempt += 1;
      const sent = await this.core.requestPasswordResetEmail(
        this.homeserver,
        email,
        this.clientSecret,
        this.sendAttempt
      );
      this.clientSecret = sent.clientSecret;
      this.sid = sent.sid;
      this.sentTo = email;
      this.step = 'email-sent';
    } catch (value) {
      const field = passwordResetFieldForError(value);
      if (field && this.step === 'form') this.setFieldError(field, passwordResetError(value));
      else this.error = passwordResetError(value);
    } finally {
      this.isBusy = false;
    }
  }

  private setFieldError(field: ResetPasswordField, message: string): void {
    this.invalidField = field;
    this.fieldError = message;
  }
}
