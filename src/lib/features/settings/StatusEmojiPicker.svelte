<script lang="ts">
  import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ProfileEmotePicker from './ProfileEmotePicker.svelte';

  let { value = $bindable(''), disabled = false }: { value?: string; disabled?: boolean } =
    $props();
  let open = $state(false);
</script>

<ProfileEmotePicker
  bind:open
  label={i18n.t('settings.statusEmoji')}
  unicodeOnly
  footer={value ? removeEmoji : undefined}
  onPickUnicode={(emoji) => {
    value = emoji;
  }}
>
  {#snippet trigger({ props })}
    <IconButton
      {...props}
      {disabled}
      variant="ghost"
      size="small"
      label={i18n.t('settings.chooseStatusEmoji')}
    >
      {#if value}<span class="status-emoji" aria-hidden="true">{value}</span>{:else}<SmileyIcon
        />{/if}
    </IconButton>
  {/snippet}
</ProfileEmotePicker>

{#snippet removeEmoji()}
  <Button
    variant="ghost"
    size="small"
    block
    onclick={() => {
      value = '';
      open = false;
    }}
  >
    {i18n.t('settings.removeStatusEmoji')}
  </Button>
{/snippet}

<style>
  .status-emoji {
    font-size: var(--font-size-heading);
    line-height: 1;
  }
</style>
