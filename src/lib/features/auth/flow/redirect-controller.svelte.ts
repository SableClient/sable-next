import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  callbackChannelName,
  createRedirectUri,
  redirectLoginType,
  tauriRedirectUri,
} from '$lib/auth/redirect';
import type { LoginFlowsView } from '@/generated/LoginFlowsView';
import type { RegistrationResultView } from '@/generated/RegistrationResultView';
import type { CoreClient } from '$lib/core/client.svelte';
import { t } from '$lib/i18n';
import { SvelteSet, SvelteURL } from 'svelte/reactivity';
import {
  authenticationError,
  logAuthenticationFailure,
  registrationError,
} from '$lib/features/auth/registration/registration-errors';

type RedirectType = 'oidc' | 'sso';
type RedirectIntent = 'login' | 'register';
type FallbackResult = Extract<RegistrationResultView, { state: 'fallback' }>;

interface RedirectControllerOptions {
  core: CoreClient;
  getHomeserver: () => string;
  getValidationError: () => string | null;
  validateHomeserver: () => Promise<LoginFlowsView | null>;
  onMarkLoggedIn: () => void;
  onMarkOnboardingPending: (userId: string) => void;
  onNavigateLoginVerification: () => Promise<void>;
  onNavigateRegistrationRecovery: () => Promise<void>;
}

export function reserveRedirectPopup(intent: RedirectIntent): Window | null {
  return window.open(
    'about:blank',
    `sable-${intent}-${crypto.randomUUID()}`,
    'popup,width=520,height=720'
  );
}

export function closeRedirectPopup(popup: Window | null): void {
  popup?.close();
}

export class RedirectController {
  pendingIntent = $state<RedirectIntent>('register');
  isLaunching = $state(false);
  isCompleting = $state(false);
  pendingOnboardingTransition = $state(false);
  loginError = $state<string | null>(null);
  registrationError = $state<string | null>(null);
  isCallbackWindow = $state(false);

  private popup: Window | null = null;
  private removeFallbackListener: (() => void) | null = null;
  private readonly authChannels = new SvelteSet<BroadcastChannel>();

  constructor(private readonly options: RedirectControllerOptions) {}

  async launch(
    type: RedirectType,
    id?: string,
    intent: RedirectIntent = 'register'
  ): Promise<void> {
    this.loginError = null;
    this.registrationError = null;
    this.pendingIntent = intent;
    this.isLaunching = true;
    const reservedPopup = isTauri() ? null : reserveRedirectPopup(intent);
    if (!isTauri() && !reservedPopup) {
      this.setError(intent, t('auth.allowPopups'));
      this.isLaunching = false;
      return;
    }

    this.popup = reservedPopup;
    let navigationStarted = false;
    try {
      const flows = await this.options.validateHomeserver();
      if (!flows) {
        this.setError(intent, this.options.getValidationError() ?? t('errors.homeserverNotFound'));
        return;
      }
      const callbackUri = this.redirectUri(type);
      const authorizationUrl =
        type === 'oidc'
          ? await this.options.core.startOidcLogin(
              this.options.getHomeserver().trim(),
              callbackUri,
              intent
            )
          : await this.options.core.startSsoLogin(
              this.options.getHomeserver().trim(),
              callbackUri,
              id,
              intent
            );
      if (isTauri()) {
        await invoke('open_auth_url', { url: authorizationUrl });
      } else {
        if (!this.popup) return;
        const popup = this.popup;
        const channel = new BroadcastChannel(
          callbackChannelName(type === 'oidc' ? authorizationUrl : callbackUri, popup.name)
        );
        this.authChannels.add(channel);
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data !== 'string' || !redirectLoginType(event.data)) return;
          void this.complete(event.data);
          channel.close();
          this.authChannels.delete(channel);
        };
        navigationStarted = true;
        popup.location.replace(authorizationUrl);
      }
    } catch (value) {
      logAuthenticationFailure(`${type}_${intent}_start`, value);
      this.setError(intent, value);
    } finally {
      if (this.popup && !navigationStarted) {
        this.popup.close();
        this.popup = null;
      }
      this.isLaunching = false;
    }
  }

  async complete(callbackUrl: string): Promise<void> {
    if (this.isCompleting) return;
    const type = redirectLoginType(callbackUrl);
    if (!type) return;
    this.isCompleting = true;
    this.pendingOnboardingTransition = this.pendingIntent === 'register';
    this.loginError = null;
    this.registrationError = null;
    try {
      if (type === 'oidc') await this.options.core.completeOidcLogin(callbackUrl);
      else await this.options.core.completeSsoLogin(callbackUrl);

      if (this.pendingIntent === 'login') {
        this.options.onMarkLoggedIn();
        await this.options.onNavigateLoginVerification();
      } else {
        const userId = this.options.core.session?.user_id;
        if (userId) this.options.onMarkOnboardingPending(userId);
        await this.options.onNavigateRegistrationRecovery();
      }
    } catch (value) {
      logAuthenticationFailure(`${type}_${this.pendingIntent}_complete`, value);
      this.setError(this.pendingIntent, value);
    } finally {
      this.pendingOnboardingTransition = false;
      this.isCompleting = false;
    }
  }

  openFallback(fallback: FallbackResult, onComplete: () => void): void {
    this.removeFallbackListener?.();
    let expectedOrigin: string;
    try {
      expectedOrigin = new SvelteURL(fallback.fallback_url).origin;
    } catch (value) {
      this.registrationError = registrationError(value);
      return;
    }
    this.popup = isTauri()
      ? null
      : window.open(
          fallback.fallback_url,
          `sable-register-stage-${crypto.randomUUID()}`,
          'popup,width=520,height=720'
        );
    if (isTauri()) {
      void invoke('open_auth_url', { url: fallback.fallback_url }).catch((value: unknown) => {
        this.registrationError = registrationError(value);
      });
      return;
    }
    if (!this.popup) {
      this.registrationError = t('auth.allowPopups');
      return;
    }

    const popup = this.popup;
    const listener = (event: MessageEvent<unknown>) => {
      if (event.origin !== expectedOrigin || event.source !== popup || event.data !== 'authDone')
        return;
      window.removeEventListener('message', listener);
      this.removeFallbackListener = null;
      popup.close();
      this.popup = null;
      onComplete();
    };
    window.addEventListener('message', listener);
    this.removeFallbackListener = () => {
      window.removeEventListener('message', listener);
    };
  }

  markCallbackWindow(): void {
    this.isCallbackWindow = true;
  }

  cleanup(): void {
    for (const channel of this.authChannels) channel.close();
    this.authChannels.clear();
    this.popup?.close();
    this.popup = null;
    this.removeFallbackListener?.();
    this.removeFallbackListener = null;
  }

  private redirectUri(type: RedirectType): string {
    const baseUrl = isTauri()
      ? tauriRedirectUri(type)
      : new SvelteURL(window.location.pathname, window.location.origin).toString();
    return createRedirectUri(type, baseUrl, crypto.randomUUID());
  }

  private setError(intent: RedirectIntent, value: unknown): void {
    if (typeof value === 'string') {
      if (intent === 'register') this.registrationError = value;
      else this.loginError = value;
      return;
    }
    if (intent === 'register') this.registrationError = registrationError(value);
    else this.loginError = authenticationError(value);
  }
}
