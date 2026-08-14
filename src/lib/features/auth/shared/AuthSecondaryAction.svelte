<script lang="ts">
  interface Props {
    label: string;
    onclick: () => void;
  }

  let { label, onclick }: Props = $props();
</script>

<div class="auth-secondary-action">
  <button class="auth-link-button" type="button" {onclick}>{label}</button>
</div>

<style>
  .auth-secondary-action {
    padding-top: var(--space-1);
    text-align: center;
  }
</style>
