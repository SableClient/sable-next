<script lang="ts">
  import type { ImageUsageView } from '@/generated/ImageUsageView';
  import type { MemberView } from '@/generated/MemberView';
  import type { PackImageView } from '@/generated/PackImageView';
  import { DropdownMenu, Popover } from 'bits-ui';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
  import VideoIcon from 'phosphor-svelte/lib/VideoIcon';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon';
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon';
  import TextStrikethroughIcon from 'phosphor-svelte/lib/TextStrikethroughIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import type { Component, Snippet } from 'svelte';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { cachedMediaUrl, loadMediaUrl } from '$lib/ui/media-url';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';

  import ComposerAutocomplete from './ComposerAutocomplete.svelte';
  import EmoteBoard from '$lib/ui/primitives/EmoteBoard.svelte';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';

  import type { AutocompleteQuery, Suggestion } from './autocomplete';
  import { suggestionsFor } from './suggestions';
  import ComposerEditorView from './editor/ComposerEditor.svelte';
  import { ComposerEditor } from './editor/composer-editor';
  import type { FormatAction } from './editor/formatting';
  import type { EmoteMedia } from './editor/node-views';
  import { composerSchema } from './editor/schema';
  import { serializeComposer } from './editor/serialize';

  const emoteSize = 24;

  const formatButtons: { action: FormatAction; label: string; icon: Component }[] = [
    { action: 'strong', label: 'composer.bold', icon: TextBIcon },
    { action: 'em', label: 'composer.italic', icon: TextItalicIcon },
    { action: 'strike', label: 'composer.strike', icon: TextStrikethroughIcon },
    { action: 'code', label: 'composer.code', icon: CodeIcon },
    { action: 'bullet_list', label: 'composer.bulletList', icon: ListBulletsIcon },
    { action: 'blockquote', label: 'composer.quote', icon: QuotesIcon },
  ];

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

  interface ComposerContext {
    kind: 'reply' | 'edit';
    eventId: string;
    sender?: string | null;
    body: string;
  }

  interface StagedFile {
    id: number;
    file: File;
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
  let prefilledFor: string | null = null;
  let staged = $state<StagedFile[]>([]);
  let sending = $state(false);
  let error = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let fileInput = $state<HTMLInputElement | null>(null);
  let empty = $state(true);
  let activeFormats = $state.raw<FormatAction[]>([]);
  let formattingOpen = $state(false);
  let dragging = $state(false);
  let doorOpen = $state(false);
  let boardOpen = $state(false);
  /** The board reopens on the tab last used, which is what a sticker-first user wants. */
  let boardTab = $state<ImageUsageView>('emoticon');
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
  let nextStagedId = 0;
  const core = useCoreClient();
  let query = $state.raw<AutocompleteQuery | null>(null);
  let dismissedAt = $state<number | null>(null);
  let activeIndex = $state(0);
  let members = $state.raw<MemberView[]>([]);
  let emotes = $state.raw<PackImageView[]>([]);
  let loadedMembersFor: string | null = null;
  let loadedEmotesFor: string | null = null;

  const media: EmoteMedia = {
    cached: (url) => cachedMediaUrl(url, emoteSize, emoteSize),
    load: (url) => loadMediaUrl(core, url, emoteSize, emoteSize),
  };

  const uid = $props.id();
  const hintId = `composer-hint-${uid}`;
  const listboxId = `composer-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  const editor = new ComposerEditor({
    media,
    label: $i18n.t('timeline.messagePlaceholder'),
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

  let hasContent = $derived(!empty || staged.length > 0);
  let panelOpen = $derived(query !== null && dismissedAt !== query.start);

  let suggestions = $derived(suggestionsFor(query, members, emotes));

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

  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));

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
      editor.refresh();
    }
  }

  function pickUnicodeFromBoard(emoji: string): void {
    boardOpen = false;
    editor.insert(composerSchema.text(emoji));
  }

  async function pickFromBoard(image: PackImageView, usage: ImageUsageView): Promise<void> {
    boardOpen = false;

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
    staged = [...staged, ...files.map((file) => ({ id: nextStagedId++, file }))];
  }

  function unstage(id: number): void {
    staged = staged.filter((item) => item.id !== id);
  }

  function filesFrom(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];
    return Array.from(dataTransfer.files).filter((file): file is File => file instanceof File);
  }

  function pick(accept: string): void {
    if (!fileInput) return;
    fileInput.accept = accept;
    fileInput.click();
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

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        <div class="context">
          <span class="context-kind">
            {context.kind === 'edit'
              ? $i18n.t('composer.editing')
              : $i18n.t('composer.replyingTo', { name: context.sender ?? '' })}
          </span>
          <span class="context-body">{context.body}</span>
          <IconButton
            size="small"
            variant="ghost"
            label={$i18n.t('composer.cancelContext')}
            onclick={onCancelContext}
          >
            <XIcon />
          </IconButton>
        </div>
      {/if}
      {#if staged.length > 0}
        <ul class="staged" aria-label={$i18n.t('composer.stagedFiles')}>
          {#each staged as item (item.id)}
            <li class="staged-item">
              <span class="staged-icon" aria-hidden="true">
                {#if item.file.type.startsWith('image/')}
                  <ImageIcon />
                {:else if item.file.type.startsWith('video/')}
                  <VideoIcon />
                {:else}
                  <FileIcon />
                {/if}
              </span>
              <span class="staged-text">
                <span class="staged-name">{item.file.name}</span>
                <span class="staged-size">{formatSize(item.file.size)}</span>
              </span>
              <IconButton
                variant="ghost"
                size="small"
                class="staged-remove"
                disabled={sending}
                label={$i18n.t('composer.removeAttachment', { name: item.file.name })}
                onclick={() => {
                  unstage(item.id);
                }}
              >
                <XIcon />
              </IconButton>
            </li>
          {/each}
        </ul>
      {/if}
      {#if formattingOpen}
        <div class="formatting" role="group" aria-label={$i18n.t('composer.formatting')}>
          {#each formatButtons as button (button.action)}
            <IconButton
              variant="ghost"
              size="small"
              class="format-button"
              label={$i18n.t(button.label)}
              aria-pressed={activeFormats.includes(button.action)}
              onclick={() => {
                editor.format(button.action);
              }}
            >
              <button.icon />
            </IconButton>
          {/each}
        </div>
      {/if}
      <form
        class="composer-row"
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {#if desktop}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="composer-door"
              disabled={sending}
              aria-label={$i18n.t('composer.insert')}
            >
              <PlusIcon />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="composer-menu" side="top" align="start" sideOffset={8}>
                <DropdownMenu.Item
                  onclick={() => {
                    pick('image/*,video/*');
                  }}
                >
                  <ImageIcon />
                  {$i18n.t('composer.photoOrVideo')}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onclick={() => {
                    pick('*');
                  }}
                >
                  <PaperclipIcon />
                  {$i18n.t('composer.attachFile')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {:else}
          <button
            type="button"
            class="composer-door"
            disabled={sending}
            aria-label={$i18n.t('composer.insert')}
            onclick={() => {
              doorOpen = true;
            }}
          >
            <PlusIcon />
          </button>
          <BottomSheet
            bind:open={doorOpen}
            label={$i18n.t('composer.insert')}
            closeLabel={$i18n.t('composer.closeInsert')}
          >
            <div class="door-sheet">
              <button
                type="button"
                onclick={() => {
                  doorOpen = false;
                  pick('image/*,video/*');
                }}
              >
                <ImageIcon />
                {$i18n.t('composer.photoOrVideo')}
              </button>
              <button
                type="button"
                onclick={() => {
                  doorOpen = false;
                  pick('*');
                }}
              >
                <PaperclipIcon />
                {$i18n.t('composer.attachFile')}
              </button>
            </div>
          </BottomSheet>
        {/if}
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
          <ComposerEditorView
            {editor}
            {empty}
            placeholder={staged.length > 0
              ? $i18n.t('composer.addMessageOrSend')
              : roomName
                ? $i18n.t('composer.messageRoom', { room: roomName })
                : $i18n.t('timeline.messagePlaceholder')}
          />
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
          {#if desktop}
            <Popover.Root bind:open={boardOpen}>
              <Popover.Trigger
                class="composer-board-trigger"
                disabled={sending}
                aria-label={$i18n.t('composer.emotesAndStickers')}
              >
                <StickerIcon />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content class="composer-board" side="top" align="end" sideOffset={10}>
                  <EmoteBoard
                    {roomId}
                    bind:tab={boardTab}
                    unicode
                    onPick={pickFromBoard}
                    onPickUnicode={pickUnicodeFromBoard}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          {:else}
            <button
              type="button"
              class="composer-board-trigger"
              disabled={sending}
              aria-label={$i18n.t('composer.emotesAndStickers')}
              onclick={() => {
                boardOpen = true;
              }}
            >
              <StickerIcon />
            </button>
            <BottomSheet
              bind:open={boardOpen}
              label={$i18n.t('composer.emotesAndStickers')}
              closeLabel={$i18n.t('composer.closeBoard')}
            >
              <EmoteBoard
                {roomId}
                bind:tab={boardTab}
                variant="sheet"
                unicode
                onPick={pickFromBoard}
                onPickUnicode={pickUnicodeFromBoard}
              />
            </BottomSheet>
          {/if}
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
    --composer-gutter: var(--page-gutter);

    margin: 0 auto calc(0.5rem + env(safe-area-inset-bottom));
    position: relative;
    width: calc(100% - var(--composer-gutter) - var(--composer-gutter));
  }

  @media (width < 32rem) {
    .composer-stack {
      --composer-gutter: var(--space-2);
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

  .context {
    align-items: center;
    border-bottom: 1px solid var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    margin-inline: 0.375rem;
    min-width: 0;
    padding: 0.375rem 0 0.3125rem;
  }

  .context-kind {
    color: var(--sable-primary-main);
    flex: 0 0 auto;
    font-weight: var(--font-weight-medium);
  }

  .context-body {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer.dragging {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-main);
  }

  .composer {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-card);
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    position: relative;
    width: 100%;
  }

  .staged {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    list-style: none;
    margin: 0;
    max-height: 7.5rem;
    overflow-y: auto;
    padding: 0.5rem 0 0.375rem;
  }

  .staged-item {
    align-items: center;
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: 0.375rem;
    max-width: 14rem;
    min-width: 0;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  }

  .staged-icon {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }

  .staged-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .staged-text {
    display: grid;
    line-height: 1.15;
    min-width: 0;
  }

  .staged-name {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staged-size {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  :global(.staged-remove) {
    flex: 0 0 auto;
  }

  :global(.staged-remove svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .composer-row {
    align-items: end;
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
    width: 100%;
  }

  .door-sheet {
    display: grid;
    gap: 0.25rem;
    padding: 0 var(--space-2) var(--space-2);
  }

  .door-sheet button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-2);
    min-height: 3rem;
    padding: 0 var(--space-2);
    text-align: left;
  }

  .door-sheet button:hover {
    background: var(--sable-surface-container-hover);
  }

  .door-sheet button :global(svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .formatting {
    border-bottom: 1px solid var(--sable-surface-container-line);
    display: flex;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
  }

  :global(.format-button) {
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    height: var(--target);
    min-height: var(--target);
    width: var(--target);
  }

  :global(.format-button[aria-pressed='true']) {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  :global(.format-button svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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

  .composer-hint {
    clip-path: inset(50%);
    height: 1px;
    margin: 0;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  /* The board writes into the draft, so it belongs to the field; the door and
     the send verb act on the message and stay on the bar. */
  .composer-field {
    align-items: flex-end;
    display: flex;
    flex: 1;
    min-width: 0;
    position: relative;
  }

  :global(.composer-board-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    bottom: 1px;
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: flex;
    height: var(--target);
    justify-content: center;
    position: absolute;
    right: 0.25rem;
    width: var(--target);
  }

  :global(.composer-board-trigger:hover),
  :global(.composer-board-trigger[data-state='open']) {
    color: var(--sable-primary-main);
  }

  :global(.composer-board-trigger:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  :global(.composer-board-trigger svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-board) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    overflow: hidden;
    z-index: var(--layer-popover);
  }

  .composer-file {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }

  :global(.composer-door),
  :global(.composer-send) {
    position: relative;
  }

  :global(.composer-door)::after,
  :global(.composer-board-trigger)::after,
  :global(.composer-send)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-door) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--target);
    justify-content: center;
    width: var(--target);
  }

  :global(.composer-door:hover) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-door[data-state='open']) {
    background: var(--sable-surface-container-active);
  }

  :global(.composer-door:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  :global(.composer-door svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-menu) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem;
    width: min(15rem, calc(100vw - 2rem));
    z-index: var(--layer-menu);
  }

  :global(.composer-menu [role='menuitem']) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 0.125rem);
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: var(--space-1);
    padding: 0.5rem 0.625rem;
    text-align: left;
  }

  :global(.composer-menu [role='menuitem']:hover),
  :global(.composer-menu [role='menuitem'][data-highlighted]) {
    background: var(--sable-bg-container-hover);
  }

  :global(.composer-menu [role='menuitem'] svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-send) {
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    height: var(--target);
    min-height: var(--target);
    width: var(--target);
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

  @media (prefers-reduced-motion: no-preference) {
    .composer {
      transition:
        border-color var(--motion-fast) var(--motion-easing-standard),
        box-shadow var(--motion-fast) var(--motion-easing-standard),
        padding var(--motion-slow) var(--motion-easing-emphasized);
    }

    :global(.composer-door) {
      transition: background-color var(--motion-normal) var(--motion-easing-standard);
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

  :global(.send-error) {
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
