<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { RegistrationResultView } from '#src/generated/RegistrationResultView';
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';

  interface Props {
    homeserver: string;
    isRegistering: boolean;
    fallback: Extract<RegistrationResultView, { state: 'fallback' }> | null;
    emailStep: Extract<RegistrationResultView, { state: 'email' }> | null;
    onOpenFallback: () => void;
    onContinueFallback: () => void;
    onRequestRegistrationEmail: (email: string) => void;
    onSubmitRegistrationEmail: (token: string) => void;
  }

  let {
    homeserver,
    isRegistering,
    fallback,
    emailStep,
    onOpenFallback,
    onContinueFallback,
    onRequestRegistrationEmail,
    onSubmitRegistrationEmail,
  }: Props = $props();

  let emailAddress = $state('');
  let emailToken = $state('');
  let stage = $derived(fallback?.stage ?? 'email');
  let completedStages = $derived((fallback?.completed ?? emailStep?.completed ?? []).length);
  let totalStages = $derived(fallback?.total_stages ?? emailStep?.total_stages ?? 0);
</script>

{#if fallback || emailStep}
  <div class="fallback-step" aria-live="polite">
    <div class="fallback-icon" aria-hidden="true"><ArrowSquareOutIcon /></div>
    {#if fallback}
      <h3>{$i18n.t('auth.finishInBrowser')}</h3>
      <p>{$i18n.t('auth.finishInBrowserDescription', { server: homeserver })}</p>
      <FormActions>
        <Button onclick={onOpenFallback} disabled={isRegistering} variant="primary">
          {$i18n.t('auth.openServerPage')}
        </Button>
        <Button onclick={onContinueFallback} disabled={isRegistering} variant="primary">
          {#if isRegistering}<Spinner />{/if}
          {$i18n.t('auth.iFinished')}
        </Button>
      </FormActions>
    {:else if emailStep}
      {#if !emailStep.email}
        <h3>{$i18n.t('auth.verifyEmail')}</h3>
        <p>{$i18n.t('auth.verifyEmailDescription')}</p>
        <form
          class="email-form"
          onsubmit={(event) => {
            event.preventDefault();
            onRequestRegistrationEmail(emailAddress);
          }}
        >
          <AuthField fieldId="registration-email" label={$i18n.t('auth.email')}>
            <TextInput
              id="registration-email"
              type="email"
              value={emailAddress}
              autocomplete="email"
              required
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                emailAddress = event.currentTarget.value;
              }}
            />
          </AuthField>
          <Button type="submit" disabled={isRegistering} variant="primary">
            {#if isRegistering}<Spinner />{/if}
            {$i18n.t('auth.sendVerificationEmail')}
          </Button>
        </form>
      {:else if emailStep.submit_url && !emailStep.verified}
        <h3>{$i18n.t('auth.enterEmailCode')}</h3>
        <p>{$i18n.t('auth.enterEmailCodeDescription', { email: emailStep.email })}</p>
        <form
          class="email-form"
          onsubmit={(event) => {
            event.preventDefault();
            onSubmitRegistrationEmail(emailToken);
          }}
        >
          <AuthField fieldId="registration-email-token" label={$i18n.t('auth.emailCode')}>
            <TextInput
              id="registration-email-token"
              value={emailToken}
              autocomplete="one-time-code"
              required
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                emailToken = event.currentTarget.value;
              }}
            />
          </AuthField>
          <Button type="submit" disabled={isRegistering} variant="primary">
            {#if isRegistering}<Spinner />{/if}
            {$i18n.t('auth.verifyEmail')}
          </Button>
        </form>
      {:else if emailStep.verified || emailStep.can_complete_out_of_band}
        <h3>{$i18n.t(emailStep.verified ? 'auth.emailVerified' : 'auth.checkYourEmail')}</h3>
        <p>
          {$i18n.t(
            emailStep.verified ? 'auth.emailVerifiedDescription' : 'auth.checkYourEmailDescription',
            { email: emailStep.email }
          )}
        </p>
        <Button onclick={onContinueFallback} disabled={isRegistering} variant="primary">
          {#if isRegistering}<Spinner />{/if}
          {$i18n.t('auth.iFinished')}
        </Button>
      {:else}
        <h3>{$i18n.t('auth.emailVerificationUnavailable')}</h3>
        <p>{$i18n.t('auth.emailVerificationUnavailableDescription')}</p>
      {/if}
    {/if}
    <p class="stage-progress">
      {$i18n.t('auth.registrationStage', {
        stage,
        current: completedStages + 1,
        total: totalStages,
      })}
    </p>
  </div>
{/if}

<style>
  .email-form,
  .fallback-step {
    display: grid;
    gap: 0.75rem;
  }

  .fallback-step {
    color: var(--sable-sec-main);
    justify-items: center;
    padding: 1rem 0;
    text-align: center;
  }

  .fallback-step p,
  .stage-progress {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  h3 {
    color: var(--sable-bg-on-container);
    font-size: var(--font-size-medium);
    margin: 0;
  }

  .fallback-icon {
    align-items: center;
    background: var(--sable-primary-container);
    border-radius: 50%;
    color: var(--sable-primary-on-container);
    display: flex;
    height: 3rem;
    justify-content: center;
    width: 3rem;
  }

  .fallback-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
