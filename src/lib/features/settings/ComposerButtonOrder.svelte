<script lang="ts">
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    preferences,
    setPreference,
    type ComposerButton,
  } from '#lib/settings/preferences.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  const labels: Record<ComposerButton, string> = {
    gif: 'settings.composerGifButton',
    sticker: 'settings.composerStickerButton',
    emoticon: 'settings.composerEmoteButton',
  };

  function move(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= preferences.composerButtonOrder.length) return;
    const next = [...preferences.composerButtonOrder];
    const source = next[index];
    const destination = next[target];
    if (source === undefined || destination === undefined) return;
    next[index] = destination;
    next[target] = source;
    setPreference('composerButtonOrder', next);
  }
</script>

<ol class="button-order">
  {#each preferences.composerButtonOrder as button, index (button)}
    <li>
      <span>{$i18n.t(labels[button])}</span>
      <div>
        <IconButton
          variant="ghost"
          size="small"
          disabled={index === 0}
          label={$i18n.t('personas.moveUp', { name: $i18n.t(labels[button]) })}
          onclick={() => move(index, -1)}><ArrowUpIcon /></IconButton
        >
        <IconButton
          variant="ghost"
          size="small"
          disabled={index === preferences.composerButtonOrder.length - 1}
          label={$i18n.t('personas.moveDown', { name: $i18n.t(labels[button]) })}
          onclick={() => move(index, 1)}><ArrowDownIcon /></IconButton
        >
      </div>
    </li>
  {/each}
</ol>

<style>
  .button-order {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    justify-content: space-between;
    min-height: var(--control-height-medium);
    padding: var(--space-100) var(--space-300);
  }

  li:last-child {
    border-bottom: 0;
  }

  li > div {
    display: flex;
  }
</style>
