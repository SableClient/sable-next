<script lang="ts">
  import ListNumbersIcon from 'phosphor-svelte/lib/ListNumbersIcon';
  import TextAlignJustifyIcon from 'phosphor-svelte/lib/TextAlignJustifyIcon';

  import { i18n } from '#lib/i18n.js';
  import PanelHeaderButton from './primitives/PanelHeaderButton.svelte';

  interface Props {
    wrapped: boolean;
    lineNumbers: boolean;
    numberable: boolean;
  }

  let { wrapped = $bindable(), lineNumbers = $bindable(), numberable }: Props = $props();
</script>

<PanelHeaderButton
  label={i18n.t('timeline.wrapCode')}
  aria-pressed={wrapped}
  onclick={() => (wrapped = !wrapped)}
>
  <TextAlignJustifyIcon />
</PanelHeaderButton>

{#if numberable}
  <PanelHeaderButton
    label={i18n.t('timeline.codeLineNumbers')}
    aria-pressed={lineNumbers}
    onclick={() => (lineNumbers = !lineNumbers)}
  >
    <ListNumbersIcon />
  </PanelHeaderButton>
{/if}
