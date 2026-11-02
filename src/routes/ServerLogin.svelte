<script lang="ts">
  import { onMount } from 'svelte';
  import { i18n } from '#lib/i18n.js';
  import AuthPage from '#lib/features/auth/shared/AuthPage.svelte';
  import AuthStatusSlot from '#lib/features/auth/shared/AuthStatusSlot.svelte';
  import '#lib/features/auth/shared/auth-card.css';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import PasswordField from '#lib/features/auth/shared/PasswordField.svelte';

  interface Props {
    endpoint: string;
    onAuthenticated: () => void;
  }

  let { endpoint, onAuthenticated }: Props = $props();
  let username = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let oidcAvailable = $state(false);
  let localAvailable = $state(true);
  let oidcStart = $state('');

  onMount(() => {
    const url = new URL(endpoint, window.location.href);
    oidcStart = new URL('/_sable/oidc/start', url).toString();
    void fetch(new URL('/_sable/oidc/status', url), { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) return;
        const methods = (await response.json()) as { oidc?: boolean; local?: boolean };
        oidcAvailable = methods.oidc === true;
        localAvailable = methods.local === true;
      })
      .catch(() => {
        oidcAvailable = false;
      });
  });

  async function submit(): Promise<void> {
    submitting = true;
    error = null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
      });
      if (!response.ok) {
        error =
          response.status === 429
            ? i18n.t('auth.serverTooManyAttempts')
            : i18n.t('auth.serverInvalidCredentials');
        return;
      }
      password = '';
      onAuthenticated();
    } catch {
      error = i18n.t('auth.serverUnreachable');
    } finally {
      submitting = false;
    }
  }
</script>

<AuthPage hasLoggedInBefore={false} title={i18n.t('auth.serverSignInTitle')}>
  <form
    class="server-login auth-card-surface login-form"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <p>{i18n.t('auth.serverSignInIntro')}</p>
    {#if oidcAvailable}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- OIDC uses the server origin -->
      <a href={oidcStart}>{i18n.t('auth.signInWithIdentityProvider')}</a>
    {/if}
    {#if localAvailable}
      <FormField dense fieldId="username" label={i18n.t('auth.username')}>
        <TextInput
          id="username"
          bind:value={username}
          autocomplete="username"
          required
          disabled={submitting}
        />
      </FormField>
      <FormField dense fieldId="password" label={i18n.t('auth.password')}>
        <PasswordField bind:value={password} disabled={submitting} />
      </FormField>
      <AuthStatusSlot message={error} />
      <FormActions>
        <Button type="submit" variant="primary" loading={submitting}>
          {submitting ? i18n.t('auth.signingIn') : i18n.t('auth.signInTitle')}
        </Button>
      </FormActions>
    {/if}
  </form>
</AuthPage>

<style>
  .server-login {
    margin: 0 auto;
    max-width: 24rem;
  }
</style>
