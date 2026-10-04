<script lang="ts">
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
  import { onMount, tick } from 'svelte';

  import ComposerBoard from '#lib/features/composer/ComposerBoard.svelte';
  import ComposerDoor from '#lib/features/composer/ComposerDoor.svelte';
  import ComposerFormatting from '#lib/features/composer/ComposerFormatting.svelte';
  import '#lib/features/composer/composer-chrome.css';
  import ComposerEditorView from '#lib/features/composer/editor/ComposerEditor.svelte';
  import { ComposerEditor } from '#lib/features/composer/editor/composer-editor.js';
  import type {
    ActiveColors,
    ColorKind,
    FormatAction,
  } from '#lib/features/composer/editor/formatting.js';
  import { isVoiceRecordingSupported } from '#lib/features/composer/voice-recorder-support.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  const previewRoomId = '!composer-preview:sable.local';
  const uid = $props.id();
  const listboxId = `${uid}-listbox`;
  const voiceSupported = isVoiceRecordingSupported();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const roomyPointer = createMediaQuery('(width >= 32rem) and (any-pointer: fine)');
  const short = $derived(
    preferences.composerForm === 'short' ||
      (preferences.composerForm === 'adaptive' && roomyPointer.matches)
  );

  let desktop = $derived(appLayout.matches);
  let showPlaceholder = $state(true);
  let activeFormats = $state.raw<FormatAction[]>([]);
  let activeColors = $state.raw<ActiveColors>({ fg: null, bg: null });
  let sourceMode = $state(false);
  let formattingOpen = $derived(preferences.formattingToolbar);
  let richText = $derived(preferences.richTextComposer);
  let configuredRich = preferences.richTextComposer;
  let showVoice = $derived(preferences.composerVoiceButton && voiceSupported);
  let sendLabel = $derived($i18n.t('timeline.sendMessage'));
  let placeholder = $derived($i18n.t('timeline.messagePlaceholder'));

  const editor = new ComposerEditor({
    media: {
      cached: () => undefined,
      load: () => Promise.resolve(''),
      hold: () => () => {},
    },
    emotes: () => [],
    label: () => $i18n.t('timeline.messagePlaceholder'),
    listboxId,
    activeOptionId: () => null,
    editable: () => true,
    onSubmit: () => {},
    onChange: (change) => {
      showPlaceholder = change.placeholder;
      activeFormats = change.active;
      if (change.colors.fg !== activeColors.fg || change.colors.bg !== activeColors.bg) {
        activeColors = change.colors;
      }
    },
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: (source: boolean) => {
      sourceMode = source;
    },
  });

  function seedSample(): void {
    sourceMode = editor.leaveSource();
    if (preferences.richTextComposer) editor.setHtml('<p>Hello <strong>bold</strong></p>');
    else editor.setText('Hello **bold**');
  }

  let previewReady = $state(false);

  onMount(() => {
    void tick().then(() => {
      previewReady = true;
      seedSample();
    });
  });

  $effect(() => {
    const next = richText;
    if (next === configuredRich) return;
    configuredRich = next;
    sourceMode = editor.leaveSource();
    editor.reconfigure();
    if (previewReady) seedSample();
  });
</script>

<aside class="composer-preview" aria-label={$i18n.t('settings.composerPreview')}>
  <p class="preview-label">{$i18n.t('settings.composerButtonOrderHint')}</p>
  <div class="composer-stack">
    <div class="composer-shell">
      <div class="composer" role="group" aria-label={$i18n.t('settings.composerPreview')}>
        <form
          class="composer-row"
          class:short
          class:formatting-open={formattingOpen}
          onsubmit={(event) => {
            event.preventDefault();
          }}
        >
          <div class="composer-before">
            <ComposerDoor {desktop} disabled onPick={() => {}} />
          </div>
          <div class="composer-field">
            <ComposerEditorView {editor} {showPlaceholder} {placeholder} />
          </div>
          {#if formattingOpen}
            <div class="composer-formatting">
              <ComposerFormatting
                active={activeFormats}
                source={sourceMode}
                markdown={sourceMode || !richText}
                colors={activeColors}
                onFormat={(action: FormatAction) => {
                  editor.format(action);
                }}
                onColor={(kind: ColorKind, value: string | null) => {
                  editor.applyColor(kind, value);
                }}
                onToggleSource={() => {
                  sourceMode = editor.toggleSource();
                }}
              />
            </div>
          {/if}
          {#snippet personaButton(onReorder: () => void)}
            <Tooltip label={$i18n.t('settings.composerButtonOrderDragHintNone')}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="small"
                  class="composer-format selection-open"
                  aria-keyshortcuts="ArrowLeft ArrowRight"
                  onclick={onReorder}
                  label={$i18n.t('personas.picker')}
                >
                  <UserSwitchIcon />
                </IconButton>
              {/snippet}
            </Tooltip>
          {/snippet}
          {#snippet formatButton(onReorder: () => void)}
            <Tooltip label={$i18n.t('settings.composerButtonOrderDragHintNone')}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="small"
                  class="composer-format selection-open"
                  aria-keyshortcuts="ArrowLeft ArrowRight"
                  aria-pressed={formattingOpen}
                  onclick={onReorder}
                  data-state={formattingOpen ? 'open' : 'closed'}
                  label={$i18n.t('composer.formatting')}
                >
                  <TextAaIcon />
                </IconButton>
              {/snippet}
            </Tooltip>
          {/snippet}
          <div class="composer-after">
            <ComposerBoard
              roomId={previewRoomId}
              {desktop}
              disabled
              reorderable
              ignoreGifAvailability
              onPick={() => {}}
              onPickUnicode={() => {}}
              extras={{
                ...(preferences.personaPicker && { persona: personaButton }),
                ...(preferences.composerFormatButton && { format: formatButton }),
              }}
            />
            {#if showVoice}
              <IconButton
                variant="ghost"
                size="small"
                class="composer-voice"
                disabled
                label={$i18n.t('composer.voiceRecord')}><MicrophoneIcon /></IconButton
              >
            {/if}
            <IconButton
              variant="ghost"
              size="small"
              class="composer-send"
              disabled
              label={sendLabel}><PaperPlaneIcon weight="fill" /></IconButton
            >
          </div>
        </form>
      </div>
    </div>
  </div>
</aside>

<style>
  .composer-preview {
    padding-block: var(--space-200);
  }

  .preview-label {
    color: var(--sec-main);
    font-size: var(--font-size-small);
    margin: 0 var(--page-gutter) var(--space-100);
  }
</style>
