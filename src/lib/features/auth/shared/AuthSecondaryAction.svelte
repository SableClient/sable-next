<script lang="ts">
  interface Props {
    label: string;
    onclick: () => void;
    disabled?: boolean;
  }

  let { label, onclick, disabled = false }: Props = $props();
</script>

<div class="auth-secondary-action">
  <button class="auth-link-button" type="button" {onclick} {disabled}>{label}</button>
</div>

<style>
  .auth-secondary-action {
    padding-top: var(--space-200);
    text-align: center;
  }
</style>
