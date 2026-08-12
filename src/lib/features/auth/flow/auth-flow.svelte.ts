import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import type { RegistrationFlowsView } from '@/generated/RegistrationFlowsView';
import type { CoreClient } from '$lib/core/client.svelte';
import { t } from '$lib/i18n';
import { CoreError } from '@/transport';
import {
  authenticationError,
  registrationError,
  registrationHomeserverError,
} from '$lib/features/auth/registration/registration-errors';
import { LEGACY_REGISTRATION_FALLBACK } from '$lib/features/auth/registration/registration-methods';

export const AUTH_CARD_MOTION_MS = 450;
export const LOGGED_IN_MARKER = 'sable-has-logged-in';

export function readReturningUser(storage: Storage | undefined): boolean {
  return storage?.getItem(LOGGED_IN_MARKER) === 'true';
}

export class AuthFlowController {
  homeserver = $state('');
  registrationToken = $state<string | null>(null);
  loginFlows = $state<LoginFlowsView | null>(null);
  registrationFlows = $state<RegistrationFlowsView | null>(null);
  error = $state<string | null>(null);
  isCheckingHomeserver = $state(false);
  isEditingHomeserver = $state(false);

  private validationGeneration = 0;
  private validatedHomeserver: string | null = null;
  private validatedRegistrationHomeserver: string | null = null;
  private registrationValidationKey = '';

  constructor(
    private readonly core: CoreClient,
    homeserver: string,
    registrationToken: string | null
  ) {
    this.homeserver = homeserver;
    this.registrationToken = registrationToken;
  }

  async validateHomeserver(displayedStage = 0): Promise<LoginFlowsView | null> {
    const candidate = this.homeserver.trim();
    if (!candidate) {
      this.error = t('auth.enterHomeserver');
      return null;
    }
    if (this.validatedHomeserver === candidate && this.loginFlows) return this.loginFlows;

    const generation = ++this.validationGeneration;
    this.isCheckingHomeserver = true;
    this.error = null;
    try {
      const flows = await this.core.loginFlows(candidate);
      if (generation !== this.validationGeneration || this.homeserver.trim() !== candidate) {
        return null;
      }
      this.validatedHomeserver = candidate;
      this.loginFlows = flows;
      return flows;
    } catch (value) {
      if (generation === this.validationGeneration && this.homeserver.trim() === candidate) {
        if (
          displayedStage === 1 &&
          value instanceof CoreError &&
          value.detail.code === 'unsupported'
        ) {
          this.validatedHomeserver = candidate;
          this.loginFlows = LEGACY_REGISTRATION_FALLBACK;
          return LEGACY_REGISTRATION_FALLBACK;
        }
        this.error =
          displayedStage === 0 ? authenticationError(value) : registrationHomeserverError(value);
      }
      return null;
    } finally {
      if (generation === this.validationGeneration) this.isCheckingHomeserver = false;
    }
  }

  async validateRegistrationHomeserver(): Promise<boolean> {
    const candidate = this.homeserver.trim();
    if (!candidate) {
      this.error = t('auth.enterHomeserver');
      return false;
    }
    if (this.validatedRegistrationHomeserver === candidate) return true;

    const generation = ++this.validationGeneration;
    this.isCheckingHomeserver = true;
    this.error = null;
    try {
      const authFlows =
        this.validatedHomeserver === candidate && this.loginFlows
          ? this.loginFlows
          : await this.core.loginFlows(candidate).catch((value: unknown) => {
              if (value instanceof CoreError && value.detail.code === 'unsupported') {
                return LEGACY_REGISTRATION_FALLBACK;
              }
              throw value;
            });
      if (generation !== this.validationGeneration || this.homeserver.trim() !== candidate) {
        return false;
      }

      this.validatedHomeserver = candidate;
      this.loginFlows = authFlows;
      if (authFlows.oauth_aware_preferred) {
        this.registrationFlows = null;
        this.validatedRegistrationHomeserver = candidate;
        return true;
      }

      try {
        const registrationFlows = await this.core.registrationFlows(candidate);
        if (generation !== this.validationGeneration || this.homeserver.trim() !== candidate) {
          return false;
        }
        this.registrationFlows = registrationFlows;
      } catch (value) {
        if (generation !== this.validationGeneration || this.homeserver.trim() !== candidate) {
          return false;
        }
        this.registrationFlows = null;
        if (!authFlows.oidc_registration && !authFlows.sso) this.error = registrationError(value);
      }
      this.validatedRegistrationHomeserver = candidate;
      return true;
    } catch (value) {
      if (generation === this.validationGeneration && this.homeserver.trim() === candidate) {
        this.error = registrationHomeserverError(value);
      }
      return false;
    } finally {
      if (generation === this.validationGeneration) this.isCheckingHomeserver = false;
    }
  }

  homeserverInput(value: string): void {
    this.homeserver = value;
    this.registrationToken = null;
    this.validatedHomeserver = null;
    this.validatedRegistrationHomeserver = null;
    this.loginFlows = null;
    this.registrationFlows = null;
    this.registrationValidationKey = '';
    this.error = null;
  }

  resetValidation(): void {
    this.validatedHomeserver = null;
    this.validatedRegistrationHomeserver = null;
    this.registrationValidationKey = '';
    this.loginFlows = null;
    this.registrationFlows = null;
    this.error = null;
  }

  clearLoginHomeserverValidation(): void {
    this.error = null;
    this.registrationToken = null;
    this.validatedHomeserver = null;
    this.validatedRegistrationHomeserver = null;
    this.registrationFlows = null;
    this.registrationValidationKey = '';
  }

  shouldValidateRegistration(displayedStage: number, completedInitialCheck: boolean): boolean {
    const candidate = this.homeserver.trim();
    if (
      displayedStage !== 1 ||
      !completedInitialCheck ||
      this.isEditingHomeserver ||
      this.isCheckingHomeserver ||
      !candidate
    ) {
      return false;
    }
    if (this.validatedRegistrationHomeserver === candidate) return false;
    if (this.registrationValidationKey === candidate) return false;
    this.registrationValidationKey = candidate;
    return true;
  }
}
