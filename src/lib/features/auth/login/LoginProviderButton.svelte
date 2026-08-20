<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';

  interface Props {
    label: string;
    launching: boolean;
    disabled?: boolean;
    onclick: () => void;
  }

  let { label, launching, disabled = false, onclick }: Props = $props();
</script>

<Button {disabled} {onclick} variant="primary">
  {launching ? $i18n.t('auth.opening') : label}
</Button>
