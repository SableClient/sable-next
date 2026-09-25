<script lang="ts">
  import '#lib/features/auth/shared/auth-card.css';
  import { goto } from '$app/navigation';
  import { onMount, untrack } from 'svelte';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthFooter from '../shared/AuthFooter.svelte';
  import AuthHeader from '../shared/AuthHeader.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';
  import PasswordField from '../shared/PasswordField.svelte';
  import { homeservers } from '../shared/homeservers.svelte.js';
  import { readReturningUser } from '../flow/auth-flow.svelte';
  import {
    ResetPasswordController,
    type ResetPasswordField,
  } from './reset-password-controller.svelte';
  import { loginHref } from './reset-password-url';

  interface Props {
    homeserver: string;
  }

  let { homeserver }: Props = $props();

  const core = useCoreClient();
  const reset = untrack(() => new ResetPasswordController(core, homeserver));
  const errorId = $props.id();
  const fieldIds: Record<ResetPasswordField, string> = {
    email: 'reset-email',
    password: 'reset-password',
    confirmPassword: 'reset-confirm-password',
  };
  let hasLoggedInBefore = $state(false);
  let checked = false;
  let starting = $derived(core.status === 'idle' || core.status === 'starting');

  $effect(() => {
    if (starting || checked) return;
    checked = true;
    void untrack(() => reset.checkHomeserver());
  });

  onMount(() => {
    hasLoggedInBefore = readReturningUser(localStorage);
  });

  function errorFor(field: ResetPasswordField): string | undefined {
    return reset.fieldError && reset.invalidField === field ? errorId : undefined;
  }

  async function submit(): Promise<void> {
    await reset.submit();
    if (reset.invalidField) document.getElementById(fieldIds[reset.invalidField])?.focus();
  }

  function backToSignIn(): void {
    void goto(loginHref(homeserver, homeservers.default));
  }
</script>

<svelte:head>
  <title>{$i18n.t('auth.resetPasswordTitle')} - Sable</title>
</svelte:head>

<main class="auth-page">
  <section class="auth-content" aria-labelledby="sable-title">
    <AuthHeader {hasLoggedInBefore} />
    <div class="auth-main">
      {#if starting || reset.step === 'checking'}
        <div class="bootstrap" role="status">
          <Spinner />
          <p>{$i18n.t(starting ? 'auth.starting' : 'auth.checkingProvider')}</p>
        </div>
      {:else}
        <div class="reset-card-slot">
          <section class="auth-card-surface reset-card" aria-labelledby="reset-password-title">
            <AuthField labelId="reset-password-title" label={$i18n.t('auth.resetPasswordTitle')}>
              {#if reset.step === 'form'}
                <AuthInfoBox>
                  <span class="provider-name">
                    {$i18n.t('auth.resetPasswordWith', { server: homeserver })}
                  </span>
                </AuthInfoBox>
              {/if}
            </AuthField>

            {#if reset.step === 'unavailable'}
              <div class="reset-step" aria-live="polite">
                <h3>{$i18n.t('auth.resetPasswordUnavailable')}</h3>
                <p>{$i18n.t('auth.resetPasswordUnavailableDescription', { server: homeserver })}</p>
              </div>
            {:else if reset.step === 'email-sent'}
              <div class="reset-step" aria-live="polite">
                <h3>{$i18n.t('auth.checkYourEmail')}</h3>
                <p>
                  {$i18n.t('auth.resetPasswordCheckEmailDescription', { email: reset.sentTo })}
                </p>
                <AuthStatusSlot message={reset.error} multiline />
                <FormActions>
                  <Button
                    onclick={() => void reset.confirm()}
                    loading={reset.isBusy}
                    variant="primary"
                  >
                    {$i18n.t('auth.resetPasswordOpenedLink')}
                  </Button>
                  <Button onclick={() => void reset.resend()} disabled={reset.isBusy}>
                    {$i18n.t('auth.resendEmail')}
                  </Button>
                </FormActions>
                <AuthSecondaryAction
                  label={$i18n.t('auth.useDifferentEmail')}
                  disabled={reset.isBusy}
                  onclick={() => {
                    reset.startOver();
                  }}
                />
              </div>
            {:else if reset.step === 'complete'}
              <div class="reset-step" aria-live="polite">
                <h3>{$i18n.t('auth.passwordResetComplete')}</h3>
                <p>{$i18n.t('auth.passwordResetCompleteDescription')}</p>
                <FormActions>
                  <Button onclick={backToSignIn} variant="primary">
                    {$i18n.t('auth.backToSignIn')}
                  </Button>
                </FormActions>
              </div>
            {:else}
              <form
                class="reset-form"
                novalidate
                onsubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <FormField dense fieldId="reset-email" label={$i18n.t('auth.email')}>
                  <TextInput
                    id="reset-email"
                    type="email"
                    value={reset.email}
                    autocomplete="email"
                    required
                    disabled={reset.isBusy}
                    aria-invalid={reset.invalidField === 'email'}
                    aria-describedby={errorFor('email')}
                    oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                      reset.setField('email', event.currentTarget.value);
                    }}
                  />
                </FormField>
                <FormField dense fieldId="reset-password" label={$i18n.t('auth.newPassword')}>
                  <PasswordField
                    id="reset-password"
                    value={reset.password}
                    disabled={reset.isBusy}
                    autocomplete="new-password"
                    invalid={reset.invalidField === 'password'}
                    describedBy={errorFor('password')}
                    oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                      reset.setField('password', event.currentTarget.value);
                    }}
                  />
                </FormField>
                <FormField
                  dense
                  fieldId="reset-confirm-password"
                  label={$i18n.t('auth.confirmNewPassword')}
                >
                  <PasswordField
                    id="reset-confirm-password"
                    value={reset.confirmPassword}
                    disabled={reset.isBusy}
                    autocomplete="new-password"
                    invalid={reset.invalidField === 'confirmPassword'}
                    describedBy={errorFor('confirmPassword')}
                    oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                      reset.setField('confirmPassword', event.currentTarget.value);
                    }}
                  />
                </FormField>
                <div class="logout-row">
                  <span>{$i18n.t('auth.signOutAllDevices')}</span>
                  <Switch
                    bind:checked={reset.logoutDevices}
                    disabled={reset.isBusy}
                    label={$i18n.t('auth.signOutAllDevices')}
                  />
                </div>
                <div class="submit-area">
                  <AuthStatusSlot
                    id={errorId}
                    message={reset.fieldError ?? reset.error}
                    multiline
                  />
                  <FormActions>
                    <Button type="submit" loading={reset.isBusy} variant="primary">
                      {$i18n.t('auth.sendResetEmail')}
                    </Button>
                  </FormActions>
                </div>
              </form>
            {/if}
          </section>

          {#if reset.step !== 'complete'}
            <div class="account-switch">
              <span>{$i18n.t('auth.rememberPassword')}</span>
              <button class="account-switch-button" type="button" onclick={backToSignIn}>
                {$i18n.t('auth.backToSignIn')}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </section>
  <AuthFooter />
</main>

<style>
  .auth-page {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding: var(--space-700) var(--space-600);
    padding-block: calc(var(--space-700) + var(--safe-top))
      calc(var(--space-700) + var(--safe-bottom));
    padding-inline: max(var(--space-600), var(--safe-left)) max(var(--space-600), var(--safe-right));
  }

  .auth-content {
    display: grid;
    flex: 1 0 auto;
    grid-template-rows: calc((100dvh - 4rem) / 3) auto;
    margin: 0 auto;
    max-width: 78rem;
    width: 100%;
  }

  .auth-main {
    align-self: start;
    min-width: 0;
    padding-bottom: var(--space-800);
  }

  .bootstrap {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: center;
  }

  .bootstrap p {
    margin: 0;
  }

  .reset-card-slot {
    margin: 0 auto;
    max-width: min(24rem, calc(100vw - 3rem));
    padding: var(--space-100);
  }

  .reset-card {
    gap: var(--space-200);
    padding-bottom: var(--space-400);
  }

  .provider-name {
    overflow-wrap: anywhere;
  }

  .reset-form,
  .reset-step {
    display: grid;
    gap: var(--space-300);
  }

  .reset-step {
    color: var(--sec-main);
    justify-items: center;
    padding: var(--space-400) 0;
    text-align: center;
  }

  .reset-step :global(.form-actions) {
    justify-self: stretch;
  }

  .reset-step p {
    color: var(--sec-main);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  h3 {
    color: var(--bg-on-container);
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .logout-row {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    justify-content: space-between;
  }

  .submit-area {
    display: grid;
    gap: var(--space-200);
  }

  .account-switch {
    align-items: center;
    color: var(--sec-main);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    justify-content: center;
    padding-top: var(--space-200);
    text-align: center;
  }

  .account-switch-button {
    background: transparent;
    border: 0;
    color: var(--primary-main);
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-bold);
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  @media (prefers-reduced-motion: no-preference) {
    .account-switch-button {
      transition:
        color var(--motion-normal) var(--motion-easing-standard),
        text-decoration-color var(--motion-normal) var(--motion-easing-standard);
    }
  }

  .account-switch-button:hover {
    color: var(--primary-main-hover);
  }

  .account-switch-button:focus-visible {
    border-radius: var(--radii-200);
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 0.15rem;
  }
</style>
