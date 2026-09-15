<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { i18n } from '#lib/i18n.js';
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    id?: string;
    value?: string;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    showPassword?: boolean;
    oninput?: HTMLInputAttributes['oninput'];
  }

  let {
    id = 'password',
    value = $bindable(''),
    disabled = false,
    invalid = false,
    describedBy,
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
    aria-describedby={describedBy}
    {oninput}
  />

  <button
    class="password-toggle choice"
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
    color: var(--sec-main);
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
    color: var(--bg-on-container);
  }

  .password-toggle:active {
    transform: scale(0.92);
  }

  .password-toggle:focus-visible {
    border-radius: var(--radius);
    outline: var(--focus-ring-width) solid var(--focus-ring);
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
        color var(--motion-normal) var(--ease-smooth-out),
        transform var(--motion-normal) var(--ease-smooth-out);
    }

    .password-toggle-icon :global(svg) {
      animation: password-icon-in var(--duration-fast) ease-in-out;
    }
  }

  @keyframes password-icon-in {
    from {
      filter: blur(var(--blur-small));
      opacity: 0;
      transform: scale(var(--scale-enter));
    }

    to {
      filter: blur(0);
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
