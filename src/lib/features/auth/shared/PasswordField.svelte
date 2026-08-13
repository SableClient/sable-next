<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { i18n } from '$lib/i18n';
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  interface Props {
    id?: string;
    value?: string;
    disabled?: boolean;
    invalid?: boolean;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    showPassword?: boolean;
    oninput?: HTMLInputAttributes['oninput'];
  }

  let {
    id = 'password',
    value = $bindable(''),
    disabled = false,
    invalid = false,
    autocomplete = 'current-password',
    showPassword = $bindable(false),
    oninput,
  }: Props = $props();
</script>

<div class="password-input">
  <TextInput
    {id}
    type={showPassword ? 'text' : 'password'}
    bind:value
    {autocomplete}
    required
    {disabled}
    aria-invalid={invalid}
    {oninput}
  />

  <button
    class="password-toggle"
    type="button"
    {disabled}
    aria-label={showPassword ? $i18n.t('auth.hidePassword') : $i18n.t('auth.showPassword')}
    aria-pressed={showPassword}
    onclick={() => {
      showPassword = !showPassword;
    }}
  >
    <span class="password-toggle-icon" aria-hidden="true">
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

<style>
  .password-input {
    --form-control-padding-inline-end: var(--control-height-medium);

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
  }

  .password-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .password-toggle:active {
    transform: scale(0.92);
  }

  .password-toggle:focus-visible {
    border-radius: var(--radius);
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: -4px;
  }

  .password-toggle-icon {
    align-items: center;
    display: flex;
    justify-content: center;
  }

  .password-toggle-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (prefers-reduced-motion: no-preference) {
    .password-toggle {
      transition:
        color 120ms ease,
        transform 100ms ease;
    }

    .password-toggle-icon :global(svg) {
      animation: password-icon-in 180ms ease-out;
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
</style>
