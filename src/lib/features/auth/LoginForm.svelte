<script lang="ts">
  import { fade } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import type { LoginFlowsView } from '@/generated/LoginFlowsView';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Combobox from '$lib/ui/primitives/Combobox.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';
  import LoginMethod from './LoginMethod.svelte';
  import PasswordField from './PasswordField.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import { smoothSlide } from './login-transitions';

  type LoginField = 'homeserver' | 'username' | 'password';
  type LoginMethodType = 'oidc' | 'sso';
  const homeservers = ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'];
  const homeserverItems = homeservers.map((value) => ({ value, label: value }));

  interface Props {
    homeserver?: string;
    username?: string;
    password?: string;
    loginFlows: LoginFlowsView | null;
    invalidField: LoginField | null;
    fieldError: string | null;
    loginError: string | null;
    isCheckingHomeserver: boolean;
    isLaunchingLogin: boolean;
    onClearHomeserverValidation: () => void;
    onValidateHomeserver: () => Promise<LoginFlowsView | null>;
    onClearFieldError: (field: Exclude<LoginField, 'homeserver'>) => void;
    onLaunchRedirectLogin: (
      loginType: LoginMethodType,
      identityProviderId?: string
    ) => Promise<void>;
    onLogin: () => Promise<void>;
  }

  let {
    homeserver = $bindable(''),
    username = $bindable(''),
    password = $bindable(''),
    loginFlows,
    invalidField,
    fieldError,
    loginError,
    isCheckingHomeserver,
    isLaunchingLogin,
    onClearHomeserverValidation,
    onValidateHomeserver,
    onClearFieldError,
    onLaunchRedirectLogin,
    onLogin,
  }: Props = $props();

  const core = useCoreClient();
  let isAuthenticating = $derived(core.status === 'authenticating');
  let showPassword = $state(false);
  let showAllLoginMethods = $state(false);
  let observedHomeserver = homeserver;

  $effect(() => {
    if (homeserver === observedHomeserver) return;
    observedHomeserver = homeserver;
    showAllLoginMethods = false;
  });

  const loginMethodOrder: Array<'oidc' | 'sso' | 'password'> = ['oidc', 'sso', 'password'];
  let preferredLoginMethod = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return null;
    if (flows.oauth_aware_preferred && flows.oidc) return 'oidc';
    return loginMethodOrder.find((method) => flows[method]) ?? null;
  });
  let availableLoginMethodCount = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return 0;
    return loginMethodOrder.filter((method) => flows[method]).length;
  });
  let firstAvailableLoginMethod = $derived.by(() => {
    const flows = loginFlows;
    if (!flows) return null;
    return loginMethodOrder.find((method) => flows[method]) ?? null;
  });
  let isPasswordLoginVisible = $derived(
    loginFlows?.password === true && (showAllLoginMethods || preferredLoginMethod === 'password')
  );
</script>

<form
  class="login-form"
  out:fade={{ duration: prefersReducedMotion.current ? 0 : 200 }}
  aria-busy={isAuthenticating}
  novalidate
  onsubmit={(event) => {
    event.preventDefault();
    void onLogin();
  }}
>
  <div class="field">
    <Label for="homeserver">{$i18n.t('auth.homeserver')}</Label>
    <Combobox
      id="homeserver"
      bind:value={homeserver}
      items={homeserverItems}
      autocapitalize="off"
      autocorrect="off"
      autocomplete="url"
      disabled={isAuthenticating}
      placeholder="matrix.org"
      spellcheck={false}
      required
      ariaInvalid={invalidField === 'homeserver'}
      oninput={onClearHomeserverValidation}
      onvaluechange={(selectedHomeserver: string) => {
        homeserver = selectedHomeserver;
        onClearHomeserverValidation();
        void onValidateHomeserver();
      }}
      onblur={() => {
        void onValidateHomeserver();
      }}
    />
    <p class:checking-active={isCheckingHomeserver} class="checking" aria-live="polite">
      {#if isCheckingHomeserver}
        <Spinner small />
        {$i18n.t('auth.checkingHomeserver')}
      {/if}
    </p>
  </div>

  {#if loginFlows?.oidc && (showAllLoginMethods || preferredLoginMethod === 'oidc')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'oidc'}
      reducedMotion={prefersReducedMotion.current}
    >
      <div class="actions">
        <Button
          disabled={isAuthenticating || isLaunchingLogin}
          onclick={() => void onLaunchRedirectLogin('oidc')}
        >
          {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithHomeserver')}
        </Button>
      </div>
    </LoginMethod>
  {/if}

  {#if loginFlows?.sso && (showAllLoginMethods || preferredLoginMethod === 'sso')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'sso'}
      reducedMotion={prefersReducedMotion.current}
    >
      {#if loginFlows.sso_identity_providers.length > 0}
        <div class="actions sso-actions">
          {#each loginFlows.sso_identity_providers as provider (provider.id)}
            <Button
              disabled={isAuthenticating || isLaunchingLogin}
              onclick={() => void onLaunchRedirectLogin('sso', provider.id)}
            >
              {$i18n.t('auth.signInWithProvider', { name: provider.name })}
            </Button>
          {/each}
        </div>
      {:else}
        <div class="actions">
          <Button
            disabled={isAuthenticating || isLaunchingLogin}
            onclick={() => void onLaunchRedirectLogin('sso')}
          >
            {isLaunchingLogin ? $i18n.t('auth.opening') : $i18n.t('auth.signInWithSso')}
          </Button>
        </div>
      {/if}
    </LoginMethod>
  {/if}

  {#if loginFlows?.password && (showAllLoginMethods || preferredLoginMethod === 'password')}
    <LoginMethod
      divider={showAllLoginMethods && firstAvailableLoginMethod !== 'password'}
      reducedMotion={prefersReducedMotion.current}
    >
      <div class="field">
        <Label for="username">{$i18n.t('auth.username')}</Label>
        <TextInput
          id="username"
          bind:value={username}
          autocomplete="username"
          required
          disabled={isAuthenticating}
          aria-invalid={invalidField === 'username'}
          oninput={() => {
            onClearFieldError('username');
          }}
        />
      </div>

      <div class="field">
        <Label for="password">{$i18n.t('auth.password')}</Label>
        <PasswordField
          bind:value={password}
          bind:showPassword
          disabled={isAuthenticating}
          invalid={invalidField === 'password'}
          oninput={() => {
            onClearFieldError('password');
          }}
        />
      </div>

      <div class="submit-area">
        <div class="error-slot" aria-live="polite">
          {#if fieldError || loginError || core.status === 'error'}
            <p class="error">{fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}</p>
          {/if}
        </div>

        <div class="actions">
          <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver}>
            {#if isAuthenticating}
              <Spinner />
            {/if}

            {isAuthenticating ? $i18n.t('auth.signingIn') : $i18n.t('auth.signIn')}
          </Button>
        </div>
      </div>
    </LoginMethod>
  {/if}

  {#if availableLoginMethodCount > 1}
    <button
      class="method-toggle"
      type="button"
      aria-expanded={showAllLoginMethods}
      onclick={() => {
        showAllLoginMethods = !showAllLoginMethods;
      }}
    >
      <span
        >{showAllLoginMethods
          ? $i18n.t('auth.hideOtherWaysToSignIn')
          : $i18n.t('auth.moreWaysToSignIn')}</span
      >
      <span class:expanded={showAllLoginMethods} class="method-toggle-icon" aria-hidden="true">
        <CaretDownIcon />
      </span>
    </button>
  {/if}

  {#if (!loginFlows && !isCheckingHomeserver) || (!isPasswordLoginVisible && (fieldError || loginError || core.status === 'error'))}
    <div class="submit-area" out:smoothSlide={{ duration: prefersReducedMotion.current ? 0 : 200 }}>
      <div class="error-slot" aria-live="polite">
        {#if fieldError || loginError || core.status === 'error'}
          <p class="error">{fieldError ?? loginError ?? $i18n.t('auth.unableToStart')}</p>
        {/if}
      </div>

      {#if !loginFlows}
        <div class="actions">
          <Button type="submit" disabled={isAuthenticating || isCheckingHomeserver}>
            {isCheckingHomeserver ? $i18n.t('auth.checking') : $i18n.t('auth.continue')}
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</form>

<style>
  .actions {
    display: grid;
  }

  .checking {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    margin: 0;
    min-height: 1.25rem;
    visibility: hidden;
  }

  .checking-active {
    visibility: visible;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .error-slot {
    min-height: 0.75rem;
  }

  @keyframes error-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  .field {
    display: grid;
    gap: 0.5rem;
  }

  .login-form {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: calc(var(--radius) * 1.5);
    display: grid;
    gap: 1.25rem;
    padding: 1.75rem;
  }

  .sso-actions {
    gap: 0.75rem;
  }

  .method-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    justify-content: center;
    padding: 0.25rem;
  }

  .method-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .method-toggle-icon {
    align-items: center;
    display: flex;
  }

  .method-toggle-icon :global(svg) {
    height: 1rem;
    width: 1rem;
  }

  .submit-area {
    display: grid;
    gap: 0.5rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .error {
      animation: error-in var(--motion-normal) ease-out;
    }

    .method-toggle-icon {
      transition: transform var(--motion-normal) ease;
    }

    .method-toggle-icon.expanded {
      transform: rotate(180deg);
    }
  }
</style>
