<script lang="ts">
  import { mergeProps } from 'bits-ui';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    onStart: () => void;
  }

  let { onStart }: Props = $props();
</script>

<Tooltip label={i18n.t('composer.voiceRecord')}>
  {#snippet trigger({ props })}
    <IconButton
      {...mergeProps(props, {
        onclick: onStart,
      })}
      variant="ghost"
      size="small"
      class="composer-voice"
      label={i18n.t('composer.voiceRecord')}
    >
      <MicrophoneIcon />
    </IconButton>
  {/snippet}
</Tooltip>
