<script lang="ts">
  import GifIcon from 'phosphor-svelte/lib/GifIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
  import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences, type ComposerButton } from '#lib/settings/preferences.svelte.js';

  const icons = {
    gif: GifIcon,
    sticker: StickerIcon,
    emoticon: SmileyIcon,
    persona: UserSwitchIcon,
    format: TextAaIcon,
  };

  const visibility = {
    gif: 'composerGifButton',
    sticker: 'composerStickerButton',
    emoticon: 'composerEmoteButton',
    persona: 'personaPicker',
    format: 'composerFormatButton',
  } as const;

  let buttons = $derived.by((): ComposerButton[] => {
    const shown = preferences.composerButtonOrder.filter(
      (button) => button === 'separator' || preferences[visibility[button]]
    );
    const hasExtras = shown.includes('persona') || shown.includes('format');
    return shown.filter((button) => button !== 'separator' || hasExtras);
  });
</script>

<div class="preview">
  <div class="stage" aria-hidden="true">
    <div class="composer" data-form={preferences.composerForm}>
      <div class="field">{$i18n.t('settings.composerFormPreviewPlaceholder')}</div>
      <div class="before"><PlusIcon /></div>
      <div class="after">
        {#each buttons as button (button)}
          {#if button === 'separator'}
            <span class="separator"></span>
          {:else}
            {@const Icon = icons[button]}
            <Icon />
          {/if}
        {/each}
        {#if preferences.composerVoiceButton}<MicrophoneIcon />{/if}
        <PaperPlaneIcon />
      </div>
    </div>
  </div>
  <p class="caption">{$i18n.t('settings.composerFormPreviewHint')}</p>
</div>

<style>
  .preview {
    container-type: inline-size;
    min-width: 0;
    overflow: hidden;
    padding: var(--space-400);
  }

  .stage {
    box-sizing: border-box;
    container-type: inline-size;
    margin-inline: auto;
    max-inline-size: 100%;
    min-width: 12rem;
    overflow: hidden;
    padding-block-end: var(--space-200);
    resize: horizontal;
    width: 100%;
  }

  .composer {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: grid;
    gap: var(--space-100);
    grid-template-areas:
      'field field'
      'before after';
    grid-template-columns: 1fr auto;
    padding: var(--space-100);
  }

  .field {
    grid-area: field;
    opacity: 0.7;
    padding: var(--space-200);
  }

  .before,
  .after {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding: var(--space-100) var(--space-200);
  }

  .before {
    grid-area: before;
  }

  .after {
    grid-area: after;
    justify-self: end;
  }

  .separator {
    align-self: center;
    border-left: var(--border-width-500) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    height: var(--size-x400);
  }

  .composer :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .composer[data-form='short'] {
    grid-template-areas: 'before field after';
    grid-template-columns: auto 1fr auto;
  }

  .composer[data-form='short'] .field {
    padding-block: var(--space-100);
  }

  @container (width >= 32rem) {
    .composer[data-form='adaptive'] {
      grid-template-areas: 'before field after';
      grid-template-columns: auto 1fr auto;
    }

    .composer[data-form='adaptive'] .field {
      padding-block: var(--space-100);
    }
  }

  .caption {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    text-align: center;
  }
</style>
