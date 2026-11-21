<script lang="ts">
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    label: string;
    onclick: () => void;
    disabled?: boolean;
    loading?: boolean;
    tone?: 'neutral' | 'danger';
  }

  let { label, onclick, disabled = false, loading = false, tone = 'neutral' }: Props = $props();
</script>

<div class="auth-secondary-action">
  <Button
    class={`auth-secondary-button tone-${tone}`}
    variant="ghost"
    {onclick}
    {disabled}
    {loading}
  >
    {label}
  </Button>
</div>

<style>
  .auth-secondary-action {
    display: flex;
    justify-content: center;
    padding-top: var(--space-200);
  }
</style>
