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
    persona: 'personas.picker',
    format: 'settings.composerFormatButton',
  };

  const visibility = {
    gif: 'composerGifButton',
    sticker: 'composerStickerButton',
    emoticon: 'composerEmoteButton',
    persona: 'personaPicker',
    format: 'composerFormatButton',
  } as const satisfies Record<ComposerButton, keyof typeof preferences>;

  let shown = $derived(
    preferences.composerButtonOrder.filter((button) => preferences[visibility[button]])
  );

  function move(button: ComposerButton, index: number, offset: number): void {
    const target = shown[index + offset];
    if (target === undefined) return;
    const next = [...preferences.composerButtonOrder];
    const sourceIndex = next.indexOf(button);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next[sourceIndex] = target;
    next[targetIndex] = button;
    setPreference('composerButtonOrder', next);
  }
</script>

<ol class="button-order">
  {#each shown as button, index (button)}
    <li>
      <span>{$i18n.t(labels[button])}</span>
      <div>
        <IconButton
          variant="subtle"
          size="small"
          disabled={index === 0}
          label={$i18n.t('personas.moveUp', { name: $i18n.t(labels[button]) })}
          onclick={() => move(button, index, -1)}><ArrowUpIcon /></IconButton
        >
        <IconButton
          variant="subtle"
          size="small"
          disabled={index === shown.length - 1}
          label={$i18n.t('personas.moveDown', { name: $i18n.t(labels[button]) })}
          onclick={() => move(button, index, 1)}><ArrowDownIcon /></IconButton
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
    padding: var(--space-100) var(--space-400);
  }

  li:last-child {
    border-bottom: 0;
  }

  li > div {
    display: flex;
  }
</style>
