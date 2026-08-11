<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { i18n } from '$lib/i18n';
  import EyeIcon from 'phosphor-icons-svelte/IconEyeRegular.svelte';
  import EyeSlashIcon from 'phosphor-icons-svelte/IconEyeSlashRegular.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  interface Props {
    value?: string;
    disabled?: boolean;
    invalid?: boolean;
    showPassword?: boolean;
    oninput?: HTMLInputAttributes['oninput'];
  }

  let {
    value = $bindable(''),
    disabled = false,
    invalid = false,
    showPassword = $bindable(false),
    oninput,
  }: Props = $props();
</script>

<div class="password-input">
  <TextInput
    id="password"
    type={showPassword ? 'text' : 'password'}
    bind:value
    autocomplete="current-password"
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
    height: 18px;
    width: 18px;
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
