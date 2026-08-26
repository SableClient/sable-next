import type { LoginFlowsView } from '#src/generated/LoginFlowsView';
import type { RegistrationFlowsView } from '#src/generated/RegistrationFlowsView';
import type { RegistrationResultView } from '#src/generated/RegistrationResultView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';
import { CoreError } from '#src/transport';
import { registrationError } from './registration-errors';

export type RegistrationField =
  | 'homeserver'
  | 'username'
  | 'password'
  | 'confirmPassword'
  | 'email'
  | 'registrationToken';

type FallbackResult = Extract<RegistrationResultView, { state: 'fallback' }>;

interface RegistrationControllerOptions {
  core: CoreClient;
  getHomeserver: () => string;
  getRegistrationFlows: () => RegistrationFlowsView | null;
  getHomeserverError: () => string | null;
  validateHomeserver: () => Promise<LoginFlowsView | null>;
  onEditHomeserver: () => void;
  onMarkOnboardingPending: (userId: string) => void;
  onRegistrationComplete: () => Promise<void>;
  onOpenFallback: (fallback: FallbackResult, onComplete: () => void) => void;
}

export function registrationFieldForStage(stage: string): RegistrationField | null {
  if (stage.includes('registration_token')) return 'registrationToken';
  if (stage.includes('password')) return 'password';
  if (stage.includes('email')) return 'email';
  return null;
}

export function hasEmailVerificationToken(token: string): boolean {
  return token.length > 0 && Array.from(token).length <= 255;
}

export function isValidRegistrationEmail(value: string, input?: HTMLInputElement | null): boolean {
  if (input) return input.validity.valid;
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

export class RegistrationController {
  registrationToken = $state<string | null>(null);
  username = $state('');
  registrationEmail = $state('');
  password = $state('');
  confirmPassword = $state('');
  result = $state<RegistrationResultView | null>(null);
  error = $state<string | null>(null);
  fieldError = $state<string | null>(null);
  invalidField = $state<RegistrationField | null>(null);
  isRegistering = $state(false);
  pendingOnboardingTransition = $state(false);

  constructor(
    private readonly options: RegistrationControllerOptions,
    token: string | null
  ) {
    this.registrationToken = token;
  }

  get fallback(): FallbackResult | null {
    return this.result?.state === 'fallback' ? this.result : null;
  }

  get emailStep(): Extract<RegistrationResultView, { state: 'email' }> | null {
    return this.result?.state === 'email' ? this.result : null;
  }

  setToken(value: string): void {
    this.registrationToken = value;
    this.clearFieldError('registrationToken');
  }

  setUsername(value: string): void {
    this.username = value;
    this.clearFieldError('username');
  }

  setEmail(value: string): void {
    this.registrationEmail = value;
    this.clearFieldError('email');
  }

  setPassword(value: string): void {
    this.password = value;
    this.clearFieldError('password');
  }

  setConfirmPassword(value: string): void {
    this.confirmPassword = value;
    this.clearFieldError('confirmPassword');
  }

  resetForHomeserverChange(): void {
    this.registrationEmail = '';
    this.result = null;
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;
  }

  setFieldError(field: RegistrationField, message: string): void {
    this.invalidField = field;
    this.fieldError = message;
    this.error = null;

    if (field === 'homeserver') this.options.onEditHomeserver();
    const fieldIds: Record<RegistrationField, string> = {
      homeserver: 'registration-homeserver',
      username: 'registration-username',
      password: 'registration-password',
      confirmPassword: 'registration-confirm-password',
      email: 'registration-email',
      registrationToken: 'registration-token',
    };
    requestAnimationFrame(() => document.getElementById(fieldIds[field])?.focus());
  }

  clearFieldError(field: Exclude<RegistrationField, 'homeserver'>): void {
    if (this.invalidField !== field) return;
    this.invalidField = null;
    this.fieldError = null;
  }

  async start(): Promise<void> {
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;

    const flows = this.options.getRegistrationFlows();
    if (!this.username.trim()) {
      this.setFieldError('username', t('auth.enterUsername'));
      return;
    }
    if (!this.password) {
      this.setFieldError('password', t('auth.enterPassword'));
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
    if (flows?.email === 'required' && !this.registrationEmail.trim()) {
      this.setFieldError('email', t('auth.enterEmail'));
      return;
    }
    if (this.registrationEmail.trim() && !isValidRegistrationEmail(this.registrationEmail.trim())) {
      this.setFieldError('email', t('auth.enterEmail'));
      return;
    }
    if (flows?.registration_token === 'required' && !this.registrationToken?.trim()) {
      this.setFieldError('registrationToken', t('auth.enterRegistrationToken'));
      return;
    }

    const loginFlows = await this.options.validateHomeserver();
    if (!loginFlows) {
      this.setFieldError(
        'homeserver',
        this.options.getHomeserverError() ?? t('errors.homeserverNotFound')
      );
      return;
    }

    this.isRegistering = true;
    this.pendingOnboardingTransition = true;
    try {
      const result = await this.options.core.register(
        this.options.getHomeserver().trim(),
        this.username.trim(),
        this.password,
        this.registrationEmail.trim() || null,
        this.registrationToken?.trim() || null
      );
      if (result.state === 'email' && this.registrationEmail.trim()) {
        await this.handleResult(
          await this.options.core.commands.requestRegistrationEmail(this.registrationEmail.trim())
        );
      } else {
        await this.handleResult(result);
      }
    } catch (value) {
      const field = this.registrationFieldForError(value);
      if (field) this.setFieldError(field, registrationError(value));
      else this.error = registrationError(value);
    } finally {
      this.pendingOnboardingTransition = false;
      this.isRegistering = false;
    }
  }

  openFallback(): void {
    const fallback = this.fallback;
    if (!fallback) return;
    this.options.onOpenFallback(fallback, () => void this.continueFallback());
  }

  async continueFallback(): Promise<void> {
    this.isRegistering = true;
    this.pendingOnboardingTransition = true;
    this.error = null;
    try {
      await this.handleResult(await this.options.core.continueRegistration());
    } catch (value) {
      const field = this.registrationFieldForError(value);
      if (field) this.setFieldError(field, registrationError(value));
      else this.error = registrationError(value);
    } finally {
      this.pendingOnboardingTransition = false;
      this.isRegistering = false;
    }
  }

  async requestEmail(address: string): Promise<void> {
    if (!address.trim()) {
      this.error = t('auth.enterEmail');
      return;
    }
    this.isRegistering = true;
    this.error = null;
    try {
      this.result = await this.options.core.commands.requestRegistrationEmail(address);
    } catch (value) {
      this.error = registrationError(value);
    } finally {
      this.isRegistering = false;
    }
  }

  async submitEmail(token: string): Promise<void> {
    if (!hasEmailVerificationToken(token)) {
      this.error = t('auth.enterEmailCode');
      return;
    }
    this.isRegistering = true;
    this.error = null;
    try {
      this.result = await this.options.core.commands.submitRegistrationEmail(token);
    } catch (value) {
      this.error = registrationError(value);
    } finally {
      this.isRegistering = false;
    }
  }

  private async handleResult(result: RegistrationResultView): Promise<void> {
    this.result = result;
    if (result.state !== 'complete') return;
    this.options.onMarkOnboardingPending(result.user_id);
    await this.options.onRegistrationComplete();
  }

  private registrationFieldForError(value: unknown): RegistrationField | null {
    if (!(value instanceof CoreError)) return null;
    switch (value.detail.code) {
      case 'username_taken':
      case 'invalid_username':
        return 'username';
      case 'invalid_email':
        return 'email';
      case 'weak_password':
        return 'password';
      case 'registration_stage_failed':
        return registrationFieldForStage(value.detail.stage);
      default:
        return null;
    }
  }
}
