import type { LoginFlowsView } from '#src/generated/LoginFlowsView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';
import {
  authenticationError,
  logAuthenticationFailure,
} from '#lib/features/auth/registration/registration-errors.js';

export type LoginField = 'homeserver' | 'username' | 'password';

interface LoginControllerOptions {
  core: CoreClient;
  getHomeserver: () => string;
  getValidationError: () => string | null;
  validateHomeserver: () => Promise<LoginFlowsView | null>;
  onInvalidateStage: () => void;
  onMarkLoggedIn: () => void;
  onMarkHomeserverChanged?: () => void;
}

export class LoginController {
  username = $state('');
  password = $state('');
  error = $state<string | null>(null);
  fieldError = $state<string | null>(null);
  invalidField = $state<LoginField | null>(null);
  isLaunching = $state(false);

  constructor(private readonly options: LoginControllerOptions) {}

  async login(): Promise<void> {
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;

    const flows = await this.options.validateHomeserver();
    if (!flows) {
      this.error = this.options.getValidationError();
      return;
    }
    if (!flows.password) {
      this.error = t('auth.chooseSignInMethod');
      return;
    }
    if (!this.username.trim()) {
      this.setFieldError('username', t('auth.enterUsername'));
      return;
    }
    if (!this.password) {
      this.setFieldError('password', t('auth.enterPassword'));
      return;
    }

    try {
      await this.options.core.login(
        this.options.getHomeserver().trim(),
        this.username.trim(),
        this.password
      );
      this.options.onMarkLoggedIn();
    } catch (value) {
      logAuthenticationFailure('password_login', value);
      this.error = authenticationError(value);
    }
  }

  setFieldError(field: Exclude<LoginField, 'homeserver'>, message: string): void {
    this.invalidField = field;
    this.fieldError = message;
    document.getElementById(field)?.focus();
  }

  clearFieldError(field: Exclude<LoginField, 'homeserver'>): void {
    if (this.invalidField !== field) return;
    this.invalidField = null;
    this.fieldError = null;
  }

  clearHomeserverValidation(): void {
    this.options.onInvalidateStage();
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;
    this.options.onMarkHomeserverChanged?.();
  }

  setLaunching(value: boolean): void {
    this.isLaunching = value;
  }

  resetForHomeserverChange(): void {
    this.error = null;
    this.fieldError = null;
    this.invalidField = null;
  }
}
