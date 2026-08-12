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
    <Label id={labelId} for={fieldId}>{label}</Label>
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

  .auth-field-label :global(.tooltip-trigger svg) {
    height: 1rem;
    width: 1rem;
  }

  .auth-field-label :global(.tooltip-trigger) {
    padding: 0;
  }
</style>
