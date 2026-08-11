<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Combobox from '$lib/components/ui/Combobox.svelte';
  import Label from '$lib/components/ui/Label.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import logo from '$lib/assets/res/svg/logo.svg';
  import { useCoreClient } from '$lib/core/context';
  import { onMount } from 'svelte';
  import EyeIcon from 'phosphor-icons-svelte/IconEyeRegular.svelte';
  import EyeSlashIcon from 'phosphor-icons-svelte/IconEyeSlashRegular.svelte';

  const core = useCoreClient();
  const homeservers = ['matrix.org', 'mozilla.org', 'unredacted.org', 'sable.moe', 'kendama.moe'];
  const homeserverItems = homeservers.map((value) => ({ value, label: value }));

  let homeserver = $state(homeservers[0]);
  let username = $state('');
  let password = $state('');
  let loginError = $state<string | null>(null);
  let isStarting = $derived(core.status === 'starting');
  let hasLoggedInBefore = $state(false);

  let showPassword = $state(false);

  onMount(() => {
    hasLoggedInBefore = localStorage.getItem('sable-has-logged-in') === 'true';
  });

  async function login(): Promise<void> {
    loginError = null;

    try {
      await core.login(homeserver.trim(), username.trim(), password);
      localStorage.setItem('sable-has-logged-in', 'true');
    } catch {
      loginError = 'Unable to sign in. Check your homeserver and credentials.';
    }
  }
</script>

<svelte:head>
  <title>Sable</title>
</svelte:head>

<main class="auth-page">
  <section class="auth-content" aria-labelledby="sable-title">
    <header class="auth-heading">
      <img class="logo" src={logo} alt="" />
      <h1 id="sable-title">
        {hasLoggedInBefore ? 'Welcome back' : 'Welcome to Sable'}
      </h1>
    </header>

    <div class="auth-main">
      {#if core.status === 'starting' || core.status === 'idle'}
        <div class="bootstrap" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <p>Starting Sable...</p>
        </div>
      {:else if core.status === 'ready'}
        <div class="bootstrap">
          <p>Signed in as <strong>{core.session?.user_id}</strong>.</p>
        </div>
      {:else}
        <form
          class="login-form"
          onsubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <div class="field">
            <Label for="homeserver">Homeserver</Label>
            <Combobox
              id="homeserver"
              bind:value={homeserver}
              items={homeserverItems}
              autocapitalize="off"
              autocorrect="off"
              autocomplete="url"
              spellcheck={false}
              required
            />
          </div>

          <div class="login-method">
            <div class="field">
              <Label for="username">Username</Label>
              <TextInput id="username" bind:value={username} autocomplete="username" required />
            </div>

            <div class="field">
              <Label for="password">Password</Label>
              <div class="password-input">
                <TextInput
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  bind:value={password}
                  autocomplete="current-password"
                  required
                />

                <button
                  class="password-toggle"
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onclick={() => {
                    showPassword = !showPassword;
                  }}
                  ><span class="password-toggle-icon" aria-hidden="true">
                    {#key showPassword}
                      {#if showPassword}
                        <EyeSlashIcon />
                      {:else}
                        <EyeIcon />
                      {/if}
                    {/key}
                  </span>
                </button>
              </div>
            </div>

            {#if loginError || core.status === 'error'}
              <p class="error" role="alert">
                {loginError ?? 'Unable to start Sable.'}
              </p>
            {/if}

            <div class="actions">
              <Button type="submit" disabled={isStarting}>
                {isStarting ? 'Signing in...' : 'Sign in'}
              </Button>
            </div>
          </div>
        </form>
      {/if}
    </div>
  </section>
</main>

<style>
  .actions {
    display: grid;
    margin-top: 0.25rem;
  }

  .auth-page {
    display: grid;
    min-height: 100dvh;
    padding: 2rem 1.5rem;
  }

  .auth-content {
    display: grid;
    grid-template-rows: 1fr auto 1fr;
    margin: auto;
    max-width: 24rem;
    min-height: calc(100dvh - 4rem);
    width: 100%;
  }

  .auth-heading {
    align-self: end;
    margin-bottom: 2rem;
    text-align: center;
  }

  .auth-heading h1 {
    font-size: 1.75rem;
    margin: 1rem 0 0;
  }

  .bootstrap {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  .bootstrap p {
    margin: 0;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: 0.875rem;
    margin: 0;
  }

  .field {
    display: grid;
    gap: 0.5rem;
  }

  .logo {
    filter: drop-shadow(0 0.375rem 0.625rem rgb(0 0 0 / 20%));
    height: 4rem;
    width: 4rem;
  }

  .login-form {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: calc(var(--radius) * 1.5);
    display: grid;
    gap: 1.5rem;
    padding: 1.75rem;
  }

  .login-method {
    border-top: 1px solid var(--sable-surface-container-line);
    display: grid;
    gap: 1.5rem;
    padding-top: 1.5rem;
  }

  .password-input {
    --input-padding-right: 2.75rem;

    display: grid;
    position: relative;
  }

  .password-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    height: 100%;
    justify-content: center;
    padding: 0;
    position: absolute;
    right: 0;
    top: 0;
    width: 2.75rem;

    transition:
      color 120ms ease,
      transform 100ms ease;
  }

  .password-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .password-toggle:active {
    transform: scale(0.92);
  }

  .password-toggle:focus-visible {
    border-radius: var(--radius);
    outline: 2px solid var(--sable-focus-ring);
    outline-offset: -4px;
  }

  .password-toggle-icon {
    align-items: center;
    display: flex;
    justify-content: center;
  }

  .password-toggle-icon :global(svg) {
    animation: password-icon-in 180ms ease-out;
    height: 18px;
    width: 18px;
  }

  @media (prefers-reduced-motion: reduce) {
    .password-toggle,
    .password-toggle-icon :global(svg) {
      animation: none;
      transition: none;
    }
  }

  @keyframes password-icon-in {
    from {
      opacity: 0;
      transform: scale(0.8) rotate(-4deg);
    }

    to {
      opacity: 1;
      transform: scale(1) rotate(0);
    }
  }

  .spinner {
    animation: spin 0.8s linear infinite;
    border: 2px solid var(--sable-bg-container-line);
    border-radius: 50%;
    border-right-color: var(--sable-primary-main);
    height: 1.25rem;
    width: 1.25rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
