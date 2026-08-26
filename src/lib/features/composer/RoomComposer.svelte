<script lang="ts">
  import type { ImageUsageView } from '#src/generated/ImageUsageView';
  import type { MemberView } from '#src/generated/MemberView';
  import type { PackImageView } from '#src/generated/PackImageView';
  import { Portal } from 'bits-ui';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';
  import { onDestroy } from 'svelte';

  import type { OutgoingMentions } from '#lib/core/client.svelte.js';
  import { maxAttachmentBytes } from '#lib/core/limits.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { pickFiles } from '#lib/platform/files.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerAutocomplete from './ComposerAutocomplete.svelte';
  import type { GifResult } from '#lib/features/gif/providers.js';
  import ComposerBoard from './ComposerBoard.svelte';
  import ComposerContextBanner from './ComposerContextBanner.svelte';
  import ComposerDoor from './ComposerDoor.svelte';
  import PersonaPicker from './PersonaPicker.svelte';
  import PollComposer from './PollComposer.svelte';
  import ComposerFormatting from './ComposerFormatting.svelte';
  import LocationComposer from './LocationComposer.svelte';
  import type { AutocompleteQuery, Suggestion } from './autocomplete';
  import { formattedForEditing, type ComposerContext } from './composer-context';
  import { clearDraft, readDraft, writeDraft } from './composer-drafts';
  import {
    filesFrom,
    formatSize,
    stageFiles,
    unstageFile,
    type StagedFile,
  } from './composer-files';
  import ComposerEditorView from './editor/ComposerEditor.svelte';
  import { ComposerEditor } from './editor/composer-editor';
  import type { FormatAction } from './editor/formatting';
  import type { EmoteMedia } from './editor/node-views';
  import { composerSchema } from './editor/schema';
  import { serializeComposer, serializePlain } from './editor/serialize';
  import { sendFailure } from './send-failure';
  import { SendQueue } from './send-queue';
  import { suggestionsFor } from './suggestions';

  const emoteSize = 24;

  interface Props {
    roomId: string;
    onSend: (
      roomId: string,
      body: string,
      formatted: string | null,
      mentions: OutgoingMentions
    ) => Promise<void>;
    onSendAttachment: (roomId: string, file: File, options: { caption?: string }) => Promise<void>;
    onSendSticker?: (roomId: string, url: string, body: string) => Promise<void>;
    onSendGif?: (roomId: string, gif: GifResult) => Promise<void>;
    onCreatePoll?: (
      roomId: string,
      question: string,
      answers: string[],
      undisclosed: boolean
    ) => Promise<void>;
    onSendLocation?: (roomId: string, body: string, geoUri: string) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
    roomName?: string | null;
    readOnly?: boolean;
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
    onSendGif,
    onCreatePoll,
    onSendLocation,
    onTyping,
    roomName = null,
    readOnly = false,
    context = null,
    onCancelContext,
    onEditLast,
  }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();
  const personas = usePersonaStore();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const uid = $props.id();
  const hintId = `composer-hint-${uid}`;
  const listboxId = `composer-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  let prefilledFor: string | null = null;
  let nextStagedId = 0;
  let restored = false;
  let preEdit: ProseMirrorNode | undefined;
  let loadedMembersFor = $state<string | null>(null);
  let loadedEmotesFor = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;

  let staged = $state<StagedFile[]>([]);
  let inFlight = $state(0);
  let error = $state<string | null>(null);
  let pollOpen = $state(false);
  let locationOpen = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let empty = $state(true);
  let activeFormats = $state.raw<FormatAction[]>([]);
  let formattingOpen = $derived(preferences.formattingToolbar);
  let richText = $derived(preferences.richTextComposer);
  let configuredRich = preferences.richTextComposer;
  let dragging = $state(false);
  let dropTarget = $derived(roomName ?? $i18n.t('timeline.thisRoom'));
  let query = $state.raw<AutocompleteQuery | null>(null);
  let dismissedAt = $state<number | null>(null);
  let activeIndex = $state(0);
  let previousContext: ComposerContext | null = null;
  let members = $state.raw<MemberView[]>([]);
  let emotes = $state.raw<PackImageView[]>([]);

  let desktop = $derived(appLayout.matches);
  let sending = $derived(inFlight > 0);
  let hasContent = $derived(!empty || staged.length > 0);
  let showPersonaPicker = $derived(preferences.personaPicker && personas.personas.length > 0);

  $effect(() => {
    if (preferences.personaPicker || preferences.personaProxying) void personas.load();
  });
  let panelOpen = $derived(query !== null && dismissedAt !== query.start);
  let suggestions = $derived(suggestionsFor(query, members, emotes, roomList.rooms));
  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));
  let placeholder = $derived(
    staged.length > 0
      ? $i18n.t('composer.addMessageOrSend')
      : roomName
        ? $i18n.t('composer.messageRoom', { room: roomName })
        : $i18n.t('timeline.messagePlaceholder')
  );

  const media: EmoteMedia = {
    cached: (url) => cachedMediaUrl(core, url, emoteSize, emoteSize),
    load: (url) => loadMediaUrl(core, url, emoteSize, emoteSize),
    hold: (url) => holdMediaUrl(core, url, emoteSize, emoteSize),
  };

  const editor = new ComposerEditor({
    media,
    emotes: () => emotes,
    label: () => $i18n.t('timeline.messagePlaceholder'),
    describedBy: hintId,
    listboxId,
    activeOptionId: () => (panelOpen && suggestions.length > 0 ? optionId(active) : null),
    editable: () => !readOnly,
    onSubmit: () => {
      void send();
    },
    onChange: (next, marks, docChanged) => {
      empty = next;
      activeFormats = marks;
      activeIndex = 0;
      if (docChanged) updateTyping();
    },
    onQuery: (next) => {
      if (!next) dismissedAt = null;
      query = next;
      if (next?.sigil === '@') void loadMembers();
      if (next?.sigil === ':') void loadEmotes();
    },
    onNavigate: navigate,
    onFiles: stage,
  });

  $effect(() => {
    void panelOpen;
    void active;
    void suggestions.length;
    editor.syncActiveOption();
  });

  $effect(() => {
    const next = richText;
    if (next === configuredRich) return;
    configuredRich = next;
    editor.reconfigure();
  });

  const queue = new SendQueue();

  $effect(() => {
    if (restored) return;
    restored = true;

    const draft = readDraft(roomId);
    if (!draft) return;
    staged = draft.staged;
    nextStagedId = draft.nextStagedId;
    if (draft.doc) editor.setDoc(composerSchema.nodeFromJSON(draft.doc));
  });

  onDestroy(() => {
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();
    queue.dispose();

    const doc = preEdit ?? (editor.isEmpty() ? undefined : editor.doc());
    if (!doc && staged.length === 0) clearDraft(roomId);
    else writeDraft(roomId, { doc: doc?.toJSON() ?? null, staged, nextStagedId });
  });

  $effect(() => {
    if (context?.kind === 'edit' && prefilledFor !== context.eventId) {
      if (prefilledFor === null && !editor.isEmpty()) preEdit = editor.doc();
      prefilledFor = context.eventId;
      /* In plain-text mode the body already is the markdown source, so
         parsing the HTML back into marks would lose it again on send. */
      const formatted = richText ? formattedForEditing(context.html) : null;
      if (formatted === null) editor.setText(context.body);
      else editor.setHtml(formatted);
    } else if (context === null) {
      prefilledFor = null;
      if (preEdit) {
        editor.setDoc(preEdit);
        preEdit = undefined;
      }
    }
  });

  $effect(() => {
    if (context === previousContext) return;

    const wasActive = previousContext !== null;
    const wasEditing = previousContext?.kind === 'edit';
    previousContext = context;
    const frame = requestAnimationFrame(() => {
      if (context !== null) {
        editor.focus();
      } else if (wasActive && (wasEditing || !desktop) && !sending) {
        editor.blur();
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) activeElement.blur();
      }
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  });

  function stopTyping(): void {
    onTyping(roomId, false).catch(() => {});
  }

  async function loadMembers(): Promise<void> {
    if (loadedMembersFor === roomId) return;
    loadedMembersFor = roomId;
    try {
      members = await core.commands.roomMembers(roomId);
    } catch {
      loadedMembersFor = null;
    }
  }

  async function loadEmotes(): Promise<void> {
    if (loadedEmotesFor === roomId) return;
    loadedEmotesFor = roomId;
    try {
      emotes = (await core.commands.imagePacks(roomId))
        .flatMap((pack) => pack.images)
        .filter((image) => image.usage.includes('emoticon'));
    } catch {
      loadedEmotesFor = null;
    }
  }

  function blurEditor(): void {
    editor.blur();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }

  function cancelContext(): void {
    onCancelContext?.();
    if (context?.kind === 'edit' || !desktop) blurEditor();
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

  function failureText(cause: unknown): string {
    const { key, values } = sendFailure(cause);
    return $i18n.t(key, values);
  }

  async function send(): Promise<void> {
    if (!hasContent || readOnly) return;

    const doc = editor.doc();
    let unsent = staged;

    inFlight += 1;
    error = null;
    editor.clear();
    staged = [];
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();

    try {
      await queue.enqueue(async () => {
        const message = doc
          ? richText
            ? serializeComposer(doc)
            : serializePlain(doc)
          : { body: '', formatted: null, mentions: { userIds: [], room: false } };
        const captioned = unsent.length === 1 && message.body !== '';

        while (unsent.length > 0) {
          const [next, ...rest] = unsent;
          await onSendAttachment(roomId, next.file, captioned ? { caption: message.body } : {});
          unsent = rest;
        }

        if (captioned || message.body === '') return;
        await onSend(roomId, message.body, message.formatted, message.mentions);
      });
      editor.clearHistory();
    } catch (cause) {
      console.debug('[sable composer] send failed', cause);
      if (doc && editor.isEmpty()) editor.setDoc(doc);
      staged = [...unsent, ...staged];
      error = failureText(cause);
    } finally {
      inFlight -= 1;
    }
  }

  function pickUnicodeFromBoard(emoji: string): void {
    editor.insert(composerSchema.text(emoji));
  }

  async function pickGifFromBoard(gif: GifResult): Promise<void> {
    if (!onSendGif) return;
    try {
      await onSendGif(roomId, gif);
      error = null;
    } catch (cause) {
      console.debug('[sable composer] gif failed', cause);
      error = failureText(cause);
    }
  }

  async function pickFromBoard(image: PackImageView, usage: ImageUsageView): Promise<void> {
    if (usage === 'sticker') {
      if (!onSendSticker) return;
      try {
        await onSendSticker(roomId, image.url, image.body ?? image.shortcode);
        error = null;
      } catch (cause) {
        console.debug('[sable composer] sticker failed', cause);
        error = failureText(cause);
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

    const tooLarge = files.find((file) => file.size > maxAttachmentBytes);
    if (tooLarge) {
      error = $i18n.t('composer.tooLarge', {
        name: tooLarge.name,
        limit: formatSize(maxAttachmentBytes),
      });
      return;
    }

    const total = [...staged.map((item) => item.file), ...files].reduce(
      (bytes, file) => bytes + file.size,
      0
    );
    if (total > maxAttachmentBytes) {
      error = $i18n.t('composer.batchTooLarge', { limit: formatSize(maxAttachmentBytes) });
      return;
    }

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
    dragging = false;
    if (event.defaultPrevented || readOnly) return;

    const files = filesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    stage(files);
  }

  function handleDragover(event: DragEvent): void {
    if (readOnly || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragging = true;
  }

  function handleDragleave(event: DragEvent): void {
    if (event.relatedTarget !== null) return;
    dragging = false;
  }

  function nodeFor(sigil: string, suggestion: Suggestion): ProseMirrorNode {
    if (sigil === '@') {
      return composerSchema.nodes.mention.create({
        userId: suggestion.id,
        name: suggestion.label,
      });
    }

    if (sigil === '#') {
      return composerSchema.nodes.mention.create({ userId: suggestion.id, name: suggestion.label });
    }

    const shortcode = suggestion.id.replace(/^pack:/, '');
    const image = emotes.find((candidate) => candidate.shortcode === shortcode);
    if (!image) return composerSchema.text(suggestion.insert);

    return composerSchema.nodes.emoticon.create({ url: image.url, shortcode });
  }

  /** The servers cost a round trip, so the mention is inserted without them. */
  async function attachVia(address: string): Promise<void> {
    if (!address.startsWith('!')) return;
    try {
      editor.attachVia(address, await core.commands.roomViaServers(address));
    } catch (error) {
      console.debug('[sable composer] via servers unavailable', error);
    }
  }

  function commit(suggestion: Suggestion): void {
    const current = query;
    if (!current) return;

    editor.replaceQuery(current, nodeFor(current.sigil, suggestion));
    if (current.sigil === '#') void attachVia(suggestion.id);
    updateTyping();
  }

  function navigate(key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean {
    if (!panelOpen) {
      if (key === 'ArrowUp' && empty && staged.length === 0 && !context && onEditLast) {
        onEditLast();
        return true;
      }
      if (key === 'Escape' && context) {
        cancelContext();
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

<svelte:window
  ondragover={handleDragover}
  ondragleave={handleDragleave}
  ondrop={handleDrop}
  ondragend={() => (dragging = false)}
/>

{#if dragging}
  <Portal>
    <div class="drop-overlay" aria-hidden="true">
      <div class="drop-card">
        <FileIcon size={40} weight="light" />
        <p class="drop-title">{$i18n.t('timeline.dropFiles', { room: dropTarget })}</p>
      </div>
    </div>
  </Portal>
{/if}

<div class="composer-stack">
  {#if readOnly}
    <div class="composer-shell">
      <div class="composer">
        <div class="composer-row">
          <p class="locked">{$i18n.t('composer.readOnly')}</p>
        </div>
      </div>
    </div>
  {:else}
    <div class="composer-shell">
      <div class="composer" role="group" aria-label={$i18n.t('timeline.messagePlaceholder')}>
        {#if context}
          <ComposerContextBanner {context} onCancel={cancelContext} />
        {/if}
        {#if staged.length > 0}
          <ComposerAttachments
            files={staged}
            onRemove={(id: number) => {
              staged = unstageFile(staged, id);
            }}
          />
        {/if}
        {#if formattingOpen && richText}
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
          <ComposerDoor
            {desktop}
            onPick={pick}
            onPoll={onCreatePoll
              ? () => {
                  pollOpen = true;
                }
              : undefined}
            onLocation={onSendLocation
              ? () => {
                  locationOpen = true;
                }
              : undefined}
            onBeforeOpen={!desktop ? blurEditor : undefined}
          />
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
                  : query.sigil === '#'
                    ? $i18n.t('composer.roomsHeading', { query: query.query })
                    : $i18n.t('composer.emotesHeading', { query: query.query })}
                {suggestions}
                {active}
                onSelect={commit}
              />
            {/if}
            <ComposerBoard
              {roomId}
              {desktop}
              onPick={pickFromBoard}
              onPickUnicode={pickUnicodeFromBoard}
              onPickGif={onSendGif ? pickGifFromBoard : undefined}
              onBeforeOpen={!desktop ? blurEditor : undefined}
            />
          </div>
          {#if showPersonaPicker}
            <PersonaPicker {roomId} onBeforeOpen={!desktop ? blurEditor : undefined} />
          {/if}
          {#if richText}
            <IconButton
              variant="ghost"
              size="small"
              class="composer-format"
              aria-pressed={formattingOpen}
              label={$i18n.t('composer.formatting')}
              onclick={() => {
                setPreference('formattingToolbar', !formattingOpen);
              }}
            >
              <TextAaIcon />
            </IconButton>
          {/if}
          <IconButton
            type="submit"
            variant="ghost"
            size="small"
            class="composer-send"
            disabled={!hasContent}
            label={$i18n.t('timeline.sendMessage')}
            onpointerdown={(event: PointerEvent) => {
              if (hasContent) event.preventDefault();
            }}
            onmousedown={(event: MouseEvent) => {
              if (hasContent) event.preventDefault();
            }}
          >
            {#if sending}
              <Spinner small />
            {:else}
              <PaperPlaneIcon weight="fill" />
            {/if}
          </IconButton>
        </form>
        <p class="composer-hint" id={hintId}>
          {preferences.enterForNewline
            ? $i18n.t('composer.hintSendModifier')
            : $i18n.t('composer.hintSend')}
        </p>
      </div>
    </div>
  {/if}
  {#if error}<Alert class="send-error" variant="critical" role="alert">{error}</Alert>{/if}
</div>

{#if onSendLocation}
  <LocationComposer
    bind:open={locationOpen}
    onSend={(body: string, geoUri: string) => {
      void queue.enqueue(async () => {
        try {
          await onSendLocation(roomId, body, geoUri);
          error = null;
        } catch (cause) {
          console.debug('[sable composer] location failed', cause);
          error = failureText(cause);
        }
      });
    }}
  />
{/if}

{#if onCreatePoll}
  <PollComposer
    bind:open={pollOpen}
    onCreate={(question: string, answers: string[], undisclosed: boolean) => {
      void onCreatePoll(roomId, question, answers, undisclosed);
    }}
  />
{/if}

<style>
  .composer-stack {
    --composer-gutter: var(--space-1);

    margin: 0 auto;
    position: relative;
    width: calc(100% - var(--composer-gutter) - var(--composer-gutter));
  }

  @media (width >= 32rem) {
    .composer-stack {
      --composer-gutter: var(--page-gutter);
    }
  }

  .composer-shell {
    align-items: end;
    display: flex;
    position: relative;
  }

  .composer {
    /* The panel behind is surface-container, so the fill has to be the variant. */
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
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

  .drop-overlay {
    align-items: center;
    background: var(--sable-overlay);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: var(--space-400);
    pointer-events: none;
    position: fixed;
    z-index: var(--layer-dialog);
  }

  .drop-card {
    align-items: center;
    background: var(--sable-bg-container);
    border: var(--border-width) dashed var(--sable-primary-main);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    color: var(--sable-primary-main);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    max-width: min(28rem, 100%);
    padding: var(--space-600) var(--space-500);
    text-align: center;
  }

  .drop-title {
    font-size: var(--font-size-h4);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-h4);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .composer-row {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding: var(--space-compact);
    width: 100%;
  }

  .locked {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 1;
    justify-content: center;
    margin: 0;
    min-height: var(--target);
    padding: var(--space-1) var(--space-2);
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
    position: relative;
    width: var(--target);
  }

  :global(.composer-format[aria-pressed='true']) {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  :global(.composer-format)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-format svg) {
    display: block;
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
    display: block;
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
  }

  /* 36px against the 40px fine-pointer hit area still clears the 0.5rem gap. */
  @media (width >= 48rem) and (hover: hover) and (pointer: fine) {
    .composer {
      --target: var(--control-height-small);
    }
  }
</style>
