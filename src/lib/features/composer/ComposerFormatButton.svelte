<script lang="ts">
  import { mergeProps } from 'bits-ui';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    open: boolean;
    onToggle: () => void;
  }

  let { open, onToggle }: Props = $props();
</script>

<Tooltip label={i18n.t('composer.formatting')}>
  {#snippet trigger({ props })}
    <IconButton
      {...mergeProps(props, {
        onclick: onToggle,
      })}
      variant="ghost"
      size="small"
      class="composer-format selection-open"
      aria-pressed={open}
      data-state={open ? 'open' : 'closed'}
      label={i18n.t('composer.formatting')}
    >
      <TextAaIcon />
    </IconButton>
  {/snippet}
</Tooltip>
