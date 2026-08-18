<script lang="ts">
  import type { ImageUsageView } from '@/generated/ImageUsageView';
  import type { MemberView } from '@/generated/MemberView';
  import type { PackImageView } from '@/generated/PackImageView';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';
  import type { Snippet } from 'svelte';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { pickFiles } from '$lib/platform/files';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';

  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerAutocomplete from './ComposerAutocomplete.svelte';
  import ComposerBoard from './ComposerBoard.svelte';
  import ComposerContextBanner from './ComposerContextBanner.svelte';
  import ComposerDoor from './ComposerDoor.svelte';
  import ComposerFormatting from './ComposerFormatting.svelte';
  import type { AutocompleteQuery, Suggestion } from './autocomplete';
  import type { ComposerContext } from './composer-context';
  import { filesFrom, stageFiles, unstageFile, type StagedFile } from './composer-files';
  import ComposerEditorView from './editor/ComposerEditor.svelte';
  import { ComposerEditor } from './editor/composer-editor';
  import type { FormatAction } from './editor/formatting';
  import type { EmoteMedia } from './editor/node-views';
  import { composerSchema } from './editor/schema';
  import { serializeComposer } from './editor/serialize';
  import { suggestionsFor } from './suggestions';

  const emoteSize = 24;

  interface Props {
    roomId: string;
    onSend: (roomId: string, body: string, formatted?: string | null) => Promise<void>;
    onSendAttachment: (roomId: string, file: File) => Promise<void>;
    onSendSticker?: (roomId: string, url: string, body: string) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
    typingLabel?: string | null;
    roomName?: string | null;
    statusTrailing?: Snippet;
    /** What the next send relates to: a message being replied to, or edited. */
    context?: ComposerContext | null;
    onCancelContext?: () => void;
    onEditLast?: () => void;
  }

  let {
    roomId,
    onSend,
    onSendAttachment,
    onSendSticker,
    onTyping,
    typingLabel = null,
    roomName = null,
    statusTrailing,
    context = null,
    onCancelContext,
    onEditLast,
  }: Props = $props();

  const core = useCoreClient();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const uid = $props.id();
  const hintId = `composer-hint-${uid}`;
  const listboxId = `composer-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  let prefilledFor: string | null = null;
  let nextStagedId = 0;
  let loadedMembersFor = $state<string | null>(null);
  let loadedEmotesFor = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;

  let staged = $state<StagedFile[]>([]);
  let sending = $state(false);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let empty = $state(true);
  let activeFormats = $state.raw<FormatAction[]>([]);
  let formattingOpen = $state(false);
  let dragging = $state(false);
  let query = $state.raw<AutocompleteQuery | null>(null);
  let dismissedAt = $state<number | null>(null);
  let activeIndex = $state(0);
  let members = $state.raw<MemberView[]>([]);
  let emotes = $state.raw<PackImageView[]>([]);

  let desktop = $derived(appLayout.matches);
  let hasContent = $derived(!empty || staged.length > 0);
  let panelOpen = $derived(query !== null && dismissedAt !== query.start);
  let suggestions = $derived(suggestionsFor(query, members, emotes));
  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));
  let placeholder = $derived(
    staged.length > 0
      ? $i18n.t('composer.addMessageOrSend')
      : roomName
        ? $i18n.t('composer.messageRoom', { room: roomName })
        : $i18n.t('timeline.messagePlaceholder')
  );

  const media: EmoteMedia = {
    cached: (url) => cachedMediaUrl(url, emoteSize, emoteSize),
    load: (url) => loadMediaUrl(core, url, emoteSize, emoteSize),
  };

  const editor = new ComposerEditor({
    media,
    label: () => $i18n.t('timeline.messagePlaceholder'),
    describedBy: hintId,
    listboxId,
    activeOptionId: () => (panelOpen && suggestions.length > 0 ? optionId(active) : null),
    editable: () => !sending,
    onSubmit: () => {
      void send();
    },
    onChange: (next, marks) => {
      empty = next;
      activeFormats = marks;
      activeIndex = 0;
      updateTyping();
    },
    onQuery: (next) => {
      if (!next) dismissedAt = null;
      query = next;
    },
    onNavigate: navigate,
    onFiles: stage,
  });

  $effect(() => {
    if (query?.sigil === '@' && loadedMembersFor !== roomId) {
      loadedMembersFor = roomId;
      void core.roomMembers(roomId).then(
        (loaded) => {
          members = loaded;
        },
        () => {
          loadedMembersFor = null;
        }
      );
    }

    if (query?.sigil === ':' && loadedEmotesFor !== roomId) {
      loadedEmotesFor = roomId;
      void core.imagePacks(roomId).then(
        (packs) => {
          emotes = packs
            .flatMap((pack) => pack.images)
            .filter((image) => image.usage.includes('emoticon'));
        },
        () => {
          loadedEmotesFor = null;
        }
      );
    }
  });

  $effect(() => {
    void panelOpen;
    void active;
    void suggestions.length;
    editor.syncActiveOption();
  });

  $effect(() => {
    return () => {
      if (typingTimeout) clearTimeout(typingTimeout);
      stopTyping();
    };
  });

  $effect(() => {
    if (context?.kind === 'edit' && prefilledFor !== context.eventId) {
      prefilledFor = context.eventId;
      editor.setText(context.body);
    } else if (context === null) {
      prefilledFor = null;
    }
  });

  function stopTyping(): void {
    onTyping(roomId, false).catch(() => {});
  }

  function updateTyping(): void {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (empty) {
      stopTyping();
      return;
    }

    onTyping(roomId, true).catch(() => {});
    typingTimeout = setTimeout(() => {
      stopTyping();
    }, 4000);
  }

  async function send(): Promise<void> {
    if (!hasContent || sending) return;

    const doc = editor.doc();
    let attachments = staged;

    sending = true;
    error = null;
    editor.clear();
    staged = [];
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();

    try {
      const message = doc ? serializeComposer(doc) : { body: '', formatted: null };
      while (attachments.length > 0) {
        const [next, ...rest] = attachments;
        await onSendAttachment(roomId, next.file);
        attachments = rest;
      }
      await onSend(roomId, message.body, message.formatted);
    } catch (cause) {
      console.debug('[sable composer] send failed', cause);
      if (doc) editor.setDoc(doc);
      staged = attachments;
      error = $i18n.t('timeline.sendFailed');
    } finally {
      sending = false;
    }
  }

  function pickUnicodeFromBoard(emoji: string): void {
    editor.insert(composerSchema.text(emoji));
  }

  async function pickFromBoard(image: PackImageView, usage: ImageUsageView): Promise<void> {
    if (usage === 'sticker') {
      if (!onSendSticker) return;
      try {
        await onSendSticker(roomId, image.url, image.body ?? image.shortcode);
        error = null;
      } catch (cause) {
        console.debug('[sable composer] sticker failed', cause);
        error = $i18n.t('timeline.sendFailed');
      }
      return;
    }

    editor.insert(
      composerSchema.nodes.emoticon.create({ url: image.url, shortcode: image.shortcode })
    );
    updateTyping();
  }

  function stage(files: File[]): void {
    if (files.length === 0) return;
    staged = stageFiles(staged, files, () => nextStagedId++);
  }

  function pick(accept: string): void {
    void (async () => {
      const picked = await pickFiles(accept);
      if (picked !== null) {
        stage(picked);
        return;
      }

      if (!fileInput) return;
      fileInput.accept = accept;
      fileInput.click();
    })();
  }

  function stageFromInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    stage(input.files ? Array.from(input.files) : []);
    input.value = '';
  }

  function handleDrop(event: DragEvent): void {
    const files = filesFrom(event.dataTransfer);
    dragging = false;
    if (files.length === 0) return;
    event.preventDefault();
    stage(files);
  }

  function handleDragover(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragging = true;
  }

  function handleDragleave(event: DragEvent): void {
    if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node) {
      if (event.currentTarget.contains(event.relatedTarget)) return;
    }
    dragging = false;
  }

  function nodeFor(sigil: string, suggestion: Suggestion): ProseMirrorNode {
    if (sigil === '@') {
      return composerSchema.nodes.mention.create({
        userId: suggestion.id,
        name: suggestion.label,
      });
    }

    const shortcode = suggestion.id.replace(/^pack:/, '');
    const image = emotes.find((candidate) => candidate.shortcode === shortcode);
    if (!image) return composerSchema.text(suggestion.insert);

    return composerSchema.nodes.emoticon.create({ url: image.url, shortcode });
  }

  function commit(suggestion: Suggestion): void {
    const current = query;
    if (!current) return;

    editor.replaceQuery(current, nodeFor(current.sigil, suggestion));
    updateTyping();
  }

  function navigate(key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean {
    if (!panelOpen) {
      if (key === 'ArrowUp' && empty && staged.length === 0 && !context && onEditLast) {
        onEditLast();
        return true;
      }
      return false;
    }

    if (key === 'Escape') {
      dismissedAt = query?.start ?? null;
      return true;
    }

    if (suggestions.length === 0) return false;

    if (key === 'ArrowDown') {
      activeIndex = (active + 1) % suggestions.length;
      return true;
    }
    if (key === 'ArrowUp') {
      activeIndex = (active - 1 + suggestions.length) % suggestions.length;
      return true;
    }

    commit(suggestions[active]);
    return true;
  }
</script>

<div class="composer-stack">
  <div class="status-row">
    <div class="typing" aria-hidden={typingLabel === null} aria-live="polite" role="status">
      {#if typingLabel}
        <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>{typingLabel}</span>
      {/if}
    </div>
    {#if statusTrailing}
      {@render statusTrailing()}
    {/if}
  </div>
  <div class="composer-shell">
    <div
      class={['composer', { dragging }]}
      role="group"
      aria-label={$i18n.t('timeline.messagePlaceholder')}
      ondrop={handleDrop}
      ondragover={handleDragover}
      ondragleave={handleDragleave}
    >
      {#if context}
        <ComposerContextBanner {context} onCancel={onCancelContext} />
      {/if}
      {#if staged.length > 0}
        <ComposerAttachments
          files={staged}
          disabled={sending}
          onRemove={(id: number) => {
            staged = unstageFile(staged, id);
          }}
        />
      {/if}
      {#if formattingOpen}
        <ComposerFormatting
          active={activeFormats}
          onFormat={(action: FormatAction) => {
            editor.format(action);
          }}
        />
      {/if}
      <form
        class="composer-row"
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <ComposerDoor {desktop} disabled={sending} onPick={pick} />
        <input
          bind:this={fileInput}
          class="composer-file"
          id="composer-file-{uid}"
          name="attachment"
          type="file"
          multiple
          tabindex="-1"
          aria-hidden="true"
          onchange={stageFromInput}
        />
        <div class="composer-field">
          <ComposerEditorView {editor} {empty} {placeholder} />
          {#if panelOpen && query}
            <ComposerAutocomplete
              id={listboxId}
              {optionId}
              sigil={query.sigil}
              heading={query.sigil === '@'
                ? $i18n.t('composer.membersHeading', { query: query.query })
                : $i18n.t('composer.emotesHeading', { query: query.query })}
              {suggestions}
              {active}
              onSelect={commit}
            />
          {/if}
          <ComposerBoard
            {roomId}
            {desktop}
            disabled={sending}
            onPick={pickFromBoard}
            onPickUnicode={pickUnicodeFromBoard}
          />
        </div>
        <IconButton
          variant="ghost"
          size="small"
          class="composer-format"
          disabled={sending}
          aria-pressed={formattingOpen}
          label={$i18n.t('composer.formatting')}
          onclick={() => {
            formattingOpen = !formattingOpen;
          }}
        >
          <TextAaIcon />
        </IconButton>
        <IconButton
          type="submit"
          variant="ghost"
          size="small"
          class="composer-send"
          loading={sending}
          disabled={!hasContent}
          label={$i18n.t('timeline.sendMessage')}
        >
          <PaperPlaneIcon weight="fill" />
        </IconButton>
      </form>
      <p class="composer-hint" id={hintId}>{$i18n.t('composer.hintSend')}</p>
    </div>
  </div>
  {#if error}<Alert class="send-error" variant="critical" role="alert">{error}</Alert>{/if}
</div>

<style>
  .composer-stack {
    --composer-gutter: var(--space-2);

    margin: 0 auto 0.95rem;
    position: relative;
    width: calc(100% - var(--composer-gutter) - var(--composer-gutter));
  }

  @media (width >= 32rem) {
    .composer-stack {
      --composer-gutter: var(--page-gutter);
    }
  }

  .status-row {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
    min-height: 1.75rem;
  }

  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    line-height: 1.25rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .typing-dots {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 0.1875rem;
  }

  .typing-dots i {
    background: var(--sable-primary-main);
    border-radius: 50%;
    height: 0.25rem;
    width: 0.25rem;
  }

  .composer-shell {
    align-items: end;
    display: flex;
    position: relative;
  }

  .composer {
    /* The panel behind is surface-container, so the fill has to be the variant. */
    background: var(--sable-surface-var-container);
    border: 1px solid transparent;
    border-radius: var(--radius-card);
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    position: relative;
    width: 100%;
  }

  /* The text entry only: `:focus-within` ringed the bar for every button too. */
  .composer:has(:global([contenteditable='true']):focus) {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .composer.dragging {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-main);
  }

  .composer-row {
    align-items: end;
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
    width: 100%;
  }

  .composer-field {
    align-items: flex-end;
    display: flex;
    flex: 1;
    min-width: 0;
    position: relative;
  }

  .composer-file {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }

  .composer-hint {
    clip-path: inset(50%);
    height: 1px;
    margin: 0;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  :global(.composer-format) {
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    width: var(--target);
  }

  :global(.composer-format[aria-pressed='true']) {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  :global(.composer-format svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-send) {
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
  }

  :global(.composer-send)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-send:disabled) {
    color: var(--sable-sec-main);
  }

  :global(.composer-send:not(:disabled):hover),
  :global(.composer-send:not(:disabled):focus-visible) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-send svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.send-error) {
    font-size: var(--font-size-small);
    margin: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .composer {
      transition:
        border-color var(--motion-fast) var(--motion-easing-standard),
        box-shadow var(--motion-fast) var(--motion-easing-standard),
        padding var(--motion-slow) var(--motion-easing-emphasized);
    }

    .typing-dots i {
      animation: typing-dot 1.2s infinite ease-in-out;
    }

    .typing-dots i:nth-child(2) {
      animation-delay: 0.15s;
    }

    .typing-dots i:nth-child(3) {
      animation-delay: 0.3s;
    }
  }

  @keyframes typing-dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }

    30% {
      opacity: 1;
      transform: translateY(-0.1875rem);
    }
  }
</style>
