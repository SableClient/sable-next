<script lang="ts">
  import type { Snippet } from 'svelte';
  import Label from '$lib/ui/primitives/Label.svelte';

  interface Props {
    fieldId?: string;
    labelId?: string;
    label: string;
    labelSuffix?: Snippet;
    children: Snippet;
  }

  let { fieldId, labelId, label, labelSuffix, children }: Props = $props();
</script>

<div class="auth-field">
  <div class="auth-field-label">
    {#if labelId}
      <h2 id={labelId}>{label}</h2>
    {:else}
      <Label for={fieldId}>{label}</Label>
    {/if}
    {@render labelSuffix?.()}
  </div>
  {@render children()}
</div>

<style>
  .auth-field {
    display: grid;
    gap: 0.25rem;
  }

  .auth-field-label {
    align-items: center;
    display: flex;
    gap: 0.375rem;
  }

  .auth-field-label h2 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .auth-field-label :global(.tooltip-trigger svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .auth-field-label :global(.tooltip-trigger) {
    padding: 0;
  }
</style>
