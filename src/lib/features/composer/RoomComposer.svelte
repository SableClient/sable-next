<script module lang="ts">
  let lastFocusedRow: HTMLElement | undefined;
</script>

<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import type {
    ImageUsageView,
    MemberView,
    PackImageInfoView,
    ImageSourcePackView,
    PackImageView,
    PersonaView,
  } from '#src/generated/protocol';
  import { mergeProps } from 'bits-ui';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';
  import { onDestroy, tick, untrack } from 'svelte';

  import type { OutgoingMentions } from '#lib/core/client.svelte.js';
  import type { SendAttachmentOptions } from '#lib/core/media.svelte.js';
  import type { SendGalleryOptions } from '#lib/core/media.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import type { ConversationSendResult } from '#lib/features/room/conversation/conversation.svelte.js';
  import type { ReplyDirection } from '#lib/features/room/timeline/timeline-format.js';
  import DeleteMessageDialog from '#lib/features/room/messages/DeleteMessageDialog.svelte';
  import { previewSources } from '#lib/features/room/media/link-preview-cache.js';
  import { previewableLinks } from '#lib/features/room/media/link-preview.js';
  import { i18n } from '#lib/i18n.js';
  import { isPackChange } from '#lib/emoji/load-packs.js';
  import { capturesFromCamera, pickFiles } from '#lib/platform/files.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { outgoingPersona } from '#lib/personas/outgoing-persona.js';
  import { personaSpaces } from './persona-spaces.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { enterInsertsNewline } from '#lib/settings/enter-key.svelte.js';
  import {
    preferences,
    setPreference,
    type ImageMetadata,
  } from '#lib/settings/preferences.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import BotCommandForm from './BotCommandForm.svelte';
  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerAutocomplete from './ComposerAutocomplete.svelte';
  import type { GifResult } from '#lib/gif/providers.js';
  import ComposerBoard from './ComposerBoard.svelte';
  import ComposerContextBanner from './ComposerContextBanner.svelte';
  import ComposerLinkPreviews from './ComposerLinkPreviews.svelte';
  import ComposerError from './ComposerError.svelte';
  import ComposerDoor from './ComposerDoor.svelte';
  import ComposerDropZone from './ComposerDropZone.svelte';
  import ComposerField from './ComposerField.svelte';
  import ComposerSendButton from './ComposerSendButton.svelte';
  import PersonaPicker from './PersonaPicker.svelte';
  import PollComposer from './PollComposer.svelte';
  import ComposerFormatting from './ComposerFormatting.svelte';
  import ComposerLinkDialog from './ComposerLinkDialog.svelte';
  import ComposerSpoilerDialog from './ComposerSpoilerDialog.svelte';
  import LocationComposer from './LocationComposer.svelte';
  import ScheduleComposer from './ScheduleComposer.svelte';
  import type { AutocompleteQuery, Suggestion } from './autocomplete';
  import { formattedForEditing, type ComposerContext } from '#lib/composer/composer-context.js';
  import {
    previewKind,
    restoreFile,
    stageFiles,
    setMetadata,
    toggleSpoiler,
    unstageFile,
    type StagedFile,
  } from '#lib/composer/composer-files.js';
  import { isMultiline } from './composer-multiline';
  import { ComposerSources } from './composer-sources.svelte';
  import { DraftSync } from './draft-sync.svelte';
  import { MENU_SELECTOR, shouldFocusComposer } from './type-to-focus';
  import { ComposerEditor } from './editor/composer-editor';
  import type { ActiveColors, ColorKind, FormatAction } from './editor/formatting';
  import type { EmoteMedia } from './editor/node-views';
  import { composerSchema } from './editor/schema';
  import { emoticonNode } from './editor/shortcodes';
  import type { BoardTab } from '#lib/ui/primitives/emote-board.js';
  import { isDialogOpen, isEditableTarget, matchesBinding } from '#lib/ui/shortcuts/binding.js';
  import { bindingFor } from '#lib/ui/shortcuts/bindings.svelte.js';
  import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';
  import type { ShortcutId } from '#lib/ui/shortcuts/shortcuts.js';
  import {
    commandTextOf,
    plainEditDoc,
    serializeComposer,
    serializePlain,
  } from './editor/serialize';
  import { isServerScheduleUnsupported, ScheduledOriginalKept, sendFailure } from './send-failure';
  import { SendQueue } from './send-queue';
  import { outgoingFile } from './outgoing-file';
  import {
    ADMIN_PREFIX,
    adminBot,
    adminBotCommands,
    adminCommandTree,
    adminScope,
  } from './admin-commands';
  import {
    botCommandId,
    buildInvocation,
    draftsFromText,
    matchBotCommand,
    type ArgumentDrafts,
    type BotCommand,
    type BotCommandInvocation,
  } from './bot-commands';
  import { parseSlash } from './slash-commands';
  import { editStep, replyStep } from './step-shortcuts';
  import { suggestionNode } from './suggestion-node';
  import { rememberSuggestion } from './suggestion-usage';
  import { emoteSuggestionId, suggestionsFor } from './suggestions';
  import { TypingNotifier } from './typing-notifier';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import { isVoiceRecordingSupported } from './voice-recorder-support';
  import './composer-chrome.css';
  import { resolveProxy, type ProxyMatch } from '#lib/personas/persona.js';

  interface Props {
    roomId: string;
    roomMembers?: readonly MemberView[];
    onSend: (
      roomId: string,
      body: string,
      formatted: string | null,
      mentions: OutgoingMentions,
      imageSourcePacks?: import('#src/generated/protocol').ImageSourcePackReferenceView[]
    ) => Promise<unknown>;
    onSendBotCommand?: (
      roomId: string,
      bot: string,
      body: string,
      invocation: BotCommandInvocation
    ) => Promise<void>;
    onSendAttachment: (roomId: string, file: File, options: SendAttachmentOptions) => Promise<void>;
    onSendGallery?: (
      roomId: string,
      files: readonly File[],
      options: SendGalleryOptions
    ) => Promise<void>;
    onSendSticker?: (
      roomId: string,
      url: string,
      body: string,
      info: PackImageInfoView | null,
      sourcePack: ImageSourcePackView | null
    ) => Promise<void>;
    onSendGif?: (roomId: string, gif: GifResult) => Promise<void>;
    onCreatePoll?: (
      roomId: string,
      question: string,
      answers: string[],
      undisclosed: boolean,
      maxSelections?: number
    ) => Promise<void>;
    onSendLocation?: (roomId: string, body: string, geoUri: string) => Promise<void>;
    onSchedule?: (
      roomId: string,
      body: string,
      formatted: string | null,
      dueTs: number
    ) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
    onQuickReact?: (
      roomId: string,
      key: string,
      sourcePack: ImageSourcePackView | null
    ) => Promise<void>;
    canReact?: boolean;
    roomName?: string | null;
    readOnly?: boolean;
    encrypted?: boolean | null;
    dismissedPreviews?: readonly string[];
    onDismissPreview?: (url: string) => void;
    /** What the next send relates to: a message being replied to, or edited. */
    context?: ComposerContext | null;
    restoredContext?: ComposerContext | null;
    onCancelContext?: () => void;
    onEditPersona?: (persona: PersonaView | null) => void;
    onToggleSilentReply?: () => void;
    onDeleteEdited?: (eventId: string, reason: string | null) => void;
    onEditLast?: (before?: string) => void;
    onEditNext?: (after: string) => void;
    onReplyStep?: (direction: ReplyDirection) => void;
    threadRoot?: string | null;
  }

  let {
    roomId,
    roomMembers,
    onSend,
    onSendBotCommand,
    onSendAttachment,
    onSendGallery,
    onSendSticker,
    onSendGif,
    onCreatePoll,
    onSendLocation,
    onSchedule,
    onTyping,
    onQuickReact,
    canReact = true,
    roomName = null,
    readOnly = false,
    encrypted = null,
    dismissedPreviews = [],
    onDismissPreview,
    context = null,
    restoredContext = null,
    onCancelContext,
    onEditPersona,
    onToggleSilentReply,
    onDeleteEdited,
    onEditLast,
    onEditNext,
    onReplyStep,
    threadRoot = null,
  }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();
  const personas = usePersonaStore();
  const appLayout = new AppLayout();
  const roomyPointer = new MediaQuery('(width >= 32rem) and (any-pointer: fine)');
  const composerShort = $derived(
    appLayout.compactHeight ||
      preferences.composerForm === 'short' ||
      (preferences.composerForm === 'adaptive' && roomyPointer.current)
  );
  const uid = $props.id();
  const hintId = `composer-hint-${uid}`;
  const listboxId = `composer-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  const draftKey = (): string => (threadRoot === null ? roomId : `${roomId}/${threadRoot}`);

  let prefilledFor: string | null = null;
  let nextStagedId = 0;
  let prefilledDoc: ProseMirrorNode | undefined;
  const sources = new ComposerSources(core, {
    roomId: () => roomId,
    roomMembers: () => roomMembers,
    botCommandsEnabled: () => onSendBotCommand !== undefined,
  });
  const typing = new TypingNotifier(
    () => roomId,
    (room, isTyping) => onTyping(room, isTyping)
  );
  let draftLinks = $state.raw<string[]>([]);
  let draftLinksTimeout: ReturnType<typeof setTimeout> | undefined;
  let boardOpen = $state(false);
  let boardTab = $state<BoardTab>('emoticon');
  let boardQuery = $state('');
  let recording = $state(false);
  let expanded = $state(false);
  let recordingDraft: ProseMirrorNode | undefined;
  const voiceSupported = isVoiceRecordingSupported();

  function isGifSearchAction(value: unknown): value is ConversationSendResult {
    return (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      value.kind === 'gifSearch' &&
      'query' in value &&
      typeof value.query === 'string'
    );
  }

  let staged = $state.raw<StagedFile[]>([]);
  let inFlight = $state(0);
  let error = $state<string | null>(null);
  let retry = $state<{ text: string; run: () => void } | null>(null);
  let pollOpen = $state(false);
  let locationOpen = $state(false);
  let scheduleOpen = $state(false);
  let linkDialogOpen = $state(false);
  let spoilerDialogOpen = $state(false);
  let sourceMode = $state(false);
  let deleteEditOpen = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let rowEl = $state<HTMLElement>();
  let beforeEl = $state<HTMLElement>();
  let afterEl = $state<HTMLElement>();
  let measurerEl = $state<HTMLElement>();
  let multiline = $state(false);
  let pointerHidden = $state(false);
  const shortLayout = $derived(
    appLayout.compactHeight || (composerShort && (!multiline || preferences.alwaysInlineEditor))
  );
  let layoutFrame: number | undefined;
  let empty = $state(true);
  let showPlaceholder = $state(true);
  let shorthandHint = $state<ProxyMatch | null>(null);
  let shorthandHintTimeout: ReturnType<typeof setTimeout> | undefined;
  let activeFormats = $state.raw<FormatAction[]>([]);
  let activeColors = $state.raw<ActiveColors>({ fg: null, bg: null });
  let formattingOpen = $derived(preferences.formattingToolbar);
  let richText = $derived(preferences.richTextComposer);
  let richSend = $derived(richText && !sourceMode);
  let configuredRich = preferences.richTextComposer;
  let query = $state.raw<AutocompleteQuery | null>(null);
  let dismissedAt = $state<number | null>(null);
  let activeIndex = $state(0);
  let previousContext: ComposerContext | null = untrack(() => restoredContext);
  let deleteEditTarget = $state.raw<ComposerContext | null>(null);
  let members = $derived(roomMembers?.length ? roomMembers : sources.loadedMembers);
  let activeBotCommand = $derived.by<{
    command: BotCommand;
    drafts: ArgumentDrafts;
    prefix: string;
  } | null>(() => {
    void roomId;
    return null;
  });

  let desktop = $derived(appLayout.current);
  let sending = $derived(inFlight > 0);
  let editingCaption = $derived(context?.kind === 'edit' && context.mediaCaption === true);
  let hasContent = $derived(!empty || staged.length > 0 || editingCaption);
  let canDeleteEdited = $derived(context?.kind === 'edit' && onDeleteEdited !== undefined);
  let editingScheduled = $derived(context?.kind === 'schedule');
  let canVoice = $derived(context?.kind !== 'edit' && !editingScheduled && voiceSupported);
  let showVoice = $derived(preferences.composerVoiceButton && canVoice);
  let contextAnnouncement = $derived(
    context?.kind === 'edit'
      ? i18n.t('composer.editing')
      : context?.kind === 'schedule'
        ? i18n.t('composer.editingScheduled')
        : context?.kind === 'reply'
          ? i18n.t('composer.replyingTo', { name: context.sender ?? '' })
          : ''
  );
  let showPersonaPicker = $derived(preferences.personaPicker && personas.personas.length > 0);

  let canSchedule = $derived(onSchedule !== undefined && hasContent && !readOnly);
  let sendShortcut = $derived(!enterInsertsNewline() ? 'Enter' : 'Shift+Enter');
  let keyboardHint = $derived(
    i18n.t(
      !hasContent && canDeleteEdited
        ? 'composer.deleteHint'
        : context?.kind === 'edit' || editingScheduled
          ? 'composer.editHint'
          : 'composer.sendHint',
      {
        shortcut: sendShortcut,
        newline: enterInsertsNewline() ? 'Enter' : 'Shift+Enter',
      }
    )
  );

  $effect(() => {
    if (preferences.personaPicker || preferences.personaProxying) void personas.load();
  });
  let quickReactEnabled = $derived(
    onQuickReact !== undefined &&
      canReact &&
      !readOnly &&
      staged.length === 0 &&
      context?.kind !== 'edit' &&
      !editingScheduled
  );
  let panelOpen = $derived(
    query !== null && dismissedAt !== query.start && (query.sigil !== '+:' || quickReactEnabled)
  );
  let admin = $derived(adminScope(roomId, roomList.rooms, core.session?.user_id));
  let botCommandsEnabled = $derived(
    onSendBotCommand !== undefined && context?.kind !== 'edit' && !editingScheduled
  );
  let offeredBotCommands = $derived(botCommandsEnabled ? sources.botCommands : []);
  let serverBot = $derived(
    admin === 'adminRoom' && core.session ? adminBot(core.session.user_id) : null
  );
  let adminPrefix = $derived(admin === 'escaped' ? `\\${ADMIN_PREFIX} ` : `${ADMIN_PREFIX} `);
  let advertisedAdminCommands = $derived(
    offeredBotCommands.filter((command) => command.sender === serverBot)
  );
  let serverCommands = $derived.by(() => {
    if (advertisedAdminCommands.length > 0) return advertisedAdminCommands;
    if (!botCommandsEnabled || !admin || !sources.adminCommands || !core.session) return [];
    return adminBotCommands(sources.adminCommands, adminBot(core.session.user_id), admin);
  });
  let slashBotCommands = $derived(
    offeredBotCommands.filter((command) => command.sender !== serverBot)
  );
  let suggestions = $derived(
    suggestionsFor(
      query,
      members,
      sources.emotes,
      roomList.rooms,
      i18n.t,
      admin,
      advertisedAdminCommands.length > 0
        ? adminCommandTree(advertisedAdminCommands)
        : sources.adminCommands,
      slashBotCommands,
      (userId, fallback) => profileOverrides.name(userId, fallback)
    )
  );

  $effect(() => {
    if (!onSendBotCommand) return;
    const target = roomId;
    return core.subscribeEvents((event) => {
      if (event.type === 'bot_commands_changed' && event.room_id === target) {
        sources.forgetBotCommands();
      }
    });
  });

  $effect(() =>
    core.subscribeEvents((event) => {
      if (!isPackChange(event)) return;
      sources.forgetEmotes();
      if (query?.sigil === ':' || query?.sigil === '+:') void sources.loadEmotes();
    })
  );

  $effect(() => {
    if (query?.sigil === '!' && admin && !sources.adminCommands) void sources.loadAdminCatalog();
  });
  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));
  let placeholder = $derived(
    staged.length > 0
      ? i18n.t(
          staged.length === 1 && preferences.sendAttachmentAsCaption
            ? 'composer.addCaptionOrSend'
            : 'composer.addMessageOrSend'
        )
      : context?.kind === 'reply' && context.sender
        ? i18n.t('composer.replyPlaceholder', { name: context.sender })
        : roomName
          ? i18n.t('composer.roomPlaceholder', { room: roomName })
          : i18n.t('timeline.messagePlaceholder')
  );

  const media: EmoteMedia = {
    cached: (url) => cachedMediaUrl(core, url, 0, 0),
    load: (url) => loadMediaUrl(core, url, 0, 0),
    hold: (url) => holdMediaUrl(core, url, 0, 0),
  };

  const editor = new ComposerEditor({
    media,
    mentionName: (userId) =>
      members.find((member) => member.user_id === userId)?.display_name ?? null,
    emotes: () => sources.emotes,
    label: () => i18n.t('timeline.messagePlaceholder'),
    describedBy: hintId,
    listboxId,
    activeOptionId: () => (panelOpen && suggestions.length > 0 ? optionId(active) : null),
    editable: () => !readOnly,
    onSubmit: () => {
      void send();
    },
    onChange: (change) => {
      empty = change.empty;
      showPlaceholder = change.placeholder;
      activeFormats = change.active;
      if (change.colors.fg !== activeColors.fg || change.colors.bg !== activeColors.bg) {
        activeColors = change.colors;
      }
      activeIndex = 0;
      if (change.docChanged) {
        typing.update(empty);
        scheduleDraftLinks();
        scheduleShorthandHinting();
        scheduleLayout();
        draft.schedulePersist();
      }
    },
    onQuery: (next) => {
      if (!next) dismissedAt = null;
      query = next;
      if (next?.sigil === '@') void sources.loadMembers();
      if (next?.sigil === ':' || next?.sigil === '+:') void sources.loadEmotes();
      if (next?.sigil === '/' || (next?.sigil === '!' && admin === 'adminRoom')) {
        void sources.loadBotCommands();
      }
    },
    onNavigate: navigate,
    onFiles: stage,
    onLinkRequest: () => {
      linkDialogOpen = true;
    },
    onSpoilerRequest: () => {
      spoilerDialogOpen = true;
    },
    onSourceToggle: (source: boolean) => {
      sourceMode = source;
    },
  });

  $effect(() => {
    void panelOpen;
    void active;
    void suggestions.length;
    editor.syncActiveOption();
  });

  function updateLayout(): void {
    const editable = editor.editable();
    if (!rowEl || !measurerEl || !editable) return;
    multiline = isMultiline({
      text: editor.text(),
      row: rowEl,
      before: beforeEl,
      after: afterEl,
      editable,
      measurer: measurerEl,
    });
  }

  function scheduleLayout(): void {
    if (layoutFrame !== undefined) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = undefined;
      updateLayout();
    });
  }

  $effect(() => {
    if (!rowEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(scheduleLayout);
    for (const element of [rowEl, beforeEl, afterEl]) if (element) observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const next = richText;
    if (next === configuredRich) return;
    configuredRich = next;
    sourceMode = editor.leaveSource();
    editor.reconfigure();
  });

  const queue = new SendQueue();

  const draft = new DraftSync({
    editor,
    files: () => ({ staged, nextStagedId }),
    setFiles: (files) => {
      staged = files.staged;
      nextStagedId = files.nextStagedId;
    },
    onLeave: (previousRoomId) => {
      prefilledFor = null;
      prefilledDoc = undefined;
      error = null;
      typing.leave(previousRoomId);
    },
  });

  $effect(() => {
    draft.open(draftKey(), core.session?.account_id ?? '', roomId);
  });

  onDestroy(() => {
    if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
    if (draftLinksTimeout) clearTimeout(draftLinksTimeout);
    if (shorthandHintTimeout) clearTimeout(shorthandHintTimeout);
    typing.stop();
    queue.dispose();
    draft.dispose();
  });

  $effect(() => {
    draft.syncRemote(draftKey(), core.session?.account_id ?? '');
  });

  $effect(() => {
    if (
      (context?.kind === 'edit' || context?.kind === 'schedule') &&
      prefilledFor !== context.eventId
    ) {
      if (prefilledFor === null && !editor.isEmpty()) draft.preEdit = editor.doc();
      prefilledFor = context.eventId;
      const formatted = formattedForEditing(context.html);
      if (formatted === null) editor.setLines(context.body);
      else if (richText) editor.setHtml(formatted);
      else editor.setDoc(plainEditDoc(context.body, formatted));
      prefilledDoc = editor.doc();
    } else if (context === null) {
      const wasEditing = prefilledFor !== null;
      prefilledFor = null;
      prefilledDoc = undefined;
      if (draft.preEdit) {
        editor.setDoc(draft.preEdit);
        draft.preEdit = undefined;
      } else if (wasEditing) {
        editor.clear();
      }
    }
  });

  $effect(() => {
    if (context === previousContext) return;

    const wasActive = previousContext !== null;
    previousContext = context;
    const frame = requestAnimationFrame(() => {
      if (context !== null) {
        editor.focus();
      } else if (wasActive && !desktop && !sending) {
        editor.blur();
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) activeElement.blur();
      }
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  });

  function openBotCommand(command: BotCommand, args: string, prefix: string): void {
    activeBotCommand = { command, drafts: draftsFromText(command, args), prefix };
    error = null;
    void sources.loadMembers();
  }

  function closeBotCommand(): void {
    activeBotCommand = null;
    editor.focus();
  }

  async function sendBotCommand(
    command: BotCommand,
    body: string,
    invocation: BotCommandInvocation
  ): Promise<boolean> {
    if (!onSendBotCommand) return false;
    const targetRoomId = roomId;
    inFlight += 1;
    error = null;
    try {
      await queue.enqueue(() => onSendBotCommand(targetRoomId, command.sender, body, invocation));
      if (activeBotCommand?.command === command) closeBotCommand();
      return true;
    } catch (cause) {
      console.debug('[sable composer] bot command failed', cause);
      error = failureText(cause);
      return false;
    } finally {
      inFlight -= 1;
    }
  }

  function commandLine(): string | null {
    if (!onSendBotCommand || staged.length > 0 || context?.kind === 'edit') return null;
    const doc = editor.doc();
    if (!doc) return null;
    const text = commandTextOf(doc).trim();
    if (admin && text.startsWith(adminPrefix)) return text;
    return parseSlash(text).kind === 'unknown' ? text : null;
  }

  async function typedBotCommand(text: string): Promise<boolean> {
    const doc = editor.doc();
    const targetRoomId = roomId;
    await Promise.all([sources.loadBotCommands(), admin ? sources.loadAdminCatalog() : undefined]);
    if (roomId !== targetRoomId || (doc && !editor.doc()?.eq(doc))) return true;
    const typed = text.startsWith('/')
      ? { line: text.slice(1), prefix: '/', commands: slashBotCommands }
      : { line: text.slice(adminPrefix.length), prefix: adminPrefix, commands: serverCommands };
    const matched = matchBotCommand(typed.line, typed.commands);
    if (!matched) return false;

    editor.clear();
    if (matched.command.parameters.length === 0 && matched.args !== '') {
      const body = `${typed.prefix}${matched.command.command}${matched.raw_args}`;
      if (
        !(await sendBotCommand(matched.command, body, {
          command: matched.command.command,
          arguments: {},
        }))
      ) {
        if (doc && roomId === targetRoomId && editor.isEmpty()) editor.setDoc(doc);
      }
      return true;
    }
    const drafts = draftsFromText(matched.command, matched.args);
    const result = buildInvocation(matched.command, drafts, typed.prefix);
    if (result.kind === 'built') {
      if (!(await sendBotCommand(matched.command, result.body, result.invocation))) {
        if (doc && roomId === targetRoomId && editor.isEmpty()) editor.setDoc(doc);
      }
    } else {
      openBotCommand(matched.command, matched.args, typed.prefix);
    }
    return true;
  }

  function blurEditor(): void {
    editor.blur();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }

  function focusFromRow(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, input, label, a, [contenteditable]')) return;

    event.preventDefault();
    editor.focus();
  }

  function confirmDeleteEdit(reason: string | null): void {
    const target = deleteEditTarget;
    if (!target) return;

    deleteEditTarget = null;
    onDeleteEdited?.(target.eventId, reason);
    cancelContext();
  }

  function cancelContext(): void {
    onCancelContext?.();
    if (context?.kind === 'edit' || editingScheduled || !desktop) blurEditor();
  }

  let shownLinks = $derived.by(() => {
    const sources = previewSources(encrypted);
    if (!sources.server && !sources.client) return [];
    return draftLinks.filter((url) => !dismissedPreviews.includes(url));
  });

  function scheduleDraftLinks(): void {
    if (draftLinksTimeout) clearTimeout(draftLinksTimeout);
    draftLinksTimeout = setTimeout(() => {
      const doc = editor.doc();
      const message = doc ? (richSend ? serializeComposer(doc) : serializePlain(doc)) : null;
      draftLinks = message?.formatted ? previewableLinks(message.formatted, message.body) : [];
    }, 300);
  }

  function scheduleShorthandHinting(): void {
    if (shorthandHintTimeout) clearTimeout(shorthandHintTimeout);
    shorthandHintTimeout = setTimeout(() => {
      const doc = editor.doc();
      const message = doc ? (richSend ? serializeComposer(doc) : serializePlain(doc)) : null;
      if (preferences.personaProxying && preferences.personaPicker) {
        if (message?.body) {
          const proxy = resolveProxy(personas.personas, message.body);
          shorthandHint = proxy ?? null;
        } else {
          shorthandHint = null;
        }
      }
    }, 300);
  }

  function failureText(cause: unknown): string {
    const { key, values } = sendFailure(cause);
    return i18n.t(key, values);
  }

  function failRetryably(cause: unknown, run: () => void): void {
    const failure = sendFailure(cause);
    error = i18n.t(failure.key, failure.values);
    retry = failure.retryable ? { text: error, run } : null;
  }

  async function send(): Promise<void> {
    if (readOnly) return;
    if (editingScheduled) {
      if (canSchedule) scheduleOpen = true;
      return;
    }
    if (!hasContent) {
      if (canDeleteEdited) {
        deleteEditTarget = context;
        deleteEditOpen = true;
      }
      return;
    }
    const typedLine = commandLine();
    if (typedLine !== null && (await typedBotCommand(typedLine))) return;

    const doc = editor.doc();
    const untouched =
      context?.kind === 'edit' &&
      prefilledDoc !== undefined &&
      doc?.eq(prefilledDoc) === true &&
      staged.length === 0
        ? { body: context.body, formatted: context.html ?? null }
        : null;
    const rich = richSend;
    const attachmentsCancelEdit = context?.kind === 'edit' && staged.length > 0;
    const captionEdit = editingCaption && !attachmentsCancelEdit;
    const asCaption = preferences.sendAttachmentAsCaption;
    let unsent = staged;

    inFlight += 1;
    error = null;
    editor.clear();
    sourceMode = editor.leaveSource();
    staged = [];
    typing.stop();

    try {
      await queue.enqueue(async () => {
        const serialized = doc
          ? rich
            ? serializeComposer(doc)
            : serializePlain(doc)
          : {
              body: '',
              formatted: null,
              mentions: { user_ids: [], room: false },
              imageSourcePacks: [],
            };
        const message = attachmentsCancelEdit
          ? { ...serialized, body: '', formatted: null, mentions: { user_ids: [], room: false } }
          : untouched
            ? { ...serialized, ...untouched }
            : serialized;
        const captioned = asCaption && unsent.length === 1 && message.body !== '';
        const gallery =
          preferences.sendAttachmentsAsGallery &&
          onSendGallery !== undefined &&
          unsent.length > 1 &&
          unsent.every((item) => !item.spoiler && previewKind(item.file) !== null);

        if (gallery) {
          await onSendGallery(roomId, await Promise.all(unsent.map(outgoingFile)), {
            caption: message.body || null,
            formattedCaption: message.formatted,
            mentions: message.mentions,
          });
          unsent = [];
          return;
        }

        while (unsent.length > 0) {
          const [next, ...rest] = unsent;
          await onSendAttachment(
            roomId,
            await outgoingFile(next),
            captioned
              ? {
                  caption: message.body,
                  formattedCaption: message.formatted,
                  mentions: message.mentions,
                  spoiler: next.spoiler,
                }
              : { spoiler: next.spoiler }
          );
          unsent = rest;
        }

        if (captioned || (message.body === '' && !captionEdit)) return;
        const action = message.imageSourcePacks
          ? await onSend(
              roomId,
              message.body,
              message.formatted,
              message.mentions,
              message.imageSourcePacks
            )
          : await onSend(roomId, message.body, message.formatted, message.mentions);
        if (isGifSearchAction(action)) {
          boardTab = 'gif';
          boardQuery = action.query;
          boardOpen = true;
        }
      });
      editor.clearHistory();
    } catch (cause) {
      console.debug('[sable composer] send failed', cause);
      if (doc && editor.isEmpty()) editor.setDoc(doc);
      staged = [...unsent, ...staged];
      failRetryably(cause, () => void send());
    } finally {
      inFlight -= 1;
    }
  }

  async function scheduleDraft(dueTs: number): Promise<void> {
    if (!onSchedule || !hasContent || readOnly) return;

    const doc = editor.doc();
    const message = doc
      ? richSend
        ? serializeComposer(doc)
        : serializePlain(doc)
      : { body: '', formatted: null };
    if (message.body === '' && staged.length === 0) return;
    if (dueTs <= Date.now()) return;
    if (staged.length > 0 && encrypted !== false) {
      error = i18n.t('composer.scheduleAttachmentEncrypted');
      return;
    }

    const attachments = staged;
    const delayIds: string[] = [];

    editor.clear();
    staged = [];
    typing.stop();

    try {
      for (const attachment of attachments) {
        delayIds.push(
          await core.media.scheduleAttachment(
            roomId,
            await outgoingFile(attachment),
            dueTs,
            attachment.spoiler,
            outgoingPersona(
              personas,
              roomId,
              personaSpaces(roomList.rooms, roomId, undefined).order
            ).persona
          )
        );
      }
      if (message.body !== '') {
        await onSchedule(roomId, message.body, message.formatted, dueTs);
      }
      editor.clearHistory();
      error = null;
    } catch (cause) {
      console.debug('[sable composer] schedule failed', cause);
      await Promise.allSettled(
        delayIds.map((delayId) => core.rpc.messages.cancelScheduled({ delay_id: delayId }))
      );
      if (cause instanceof ScheduledOriginalKept) {
        editor.clearHistory();
        error = i18n.t('composer.scheduledOriginalKept');
        return;
      }
      if (doc && editor.isEmpty()) editor.setDoc(doc);
      staged = [...attachments, ...staged];
      error = i18n.t(
        attachments.length > 0 && isServerScheduleUnsupported(cause)
          ? 'composer.scheduleAttachmentUnsupported'
          : 'composer.scheduleFailed'
      );
    }
  }

  function startRecording(): void {
    recordingDraft = editor.doc();
    recording = true;
  }

  async function stopRecording(): Promise<void> {
    const draft = recordingDraft;
    recordingDraft = undefined;
    recording = false;
    await tick();
    if (draft && editor.isEmpty()) editor.setDoc(draft);
  }

  async function sendVoice(file: File): Promise<void> {
    void stopRecording();
    inFlight += 1;
    error = null;

    try {
      await queue.enqueue(async () => {
        await onSendAttachment(roomId, file, {});
      });
    } catch (cause) {
      console.debug('[sable composer] voice message failed', cause);
      failRetryably(cause, () => void sendVoice(file));
    } finally {
      inFlight -= 1;
    }
  }

  export function insertMention(userId: string, name: string): void {
    editor.insert(
      composerSchema.nodes.mention.create({
        userId,
        name: name.startsWith('@') ? name : `@${name}`,
      })
    );
    typing.update(empty);
  }

  // The popover hands focus back to its trigger as it closes.
  function focusEditorAfterPick(): void {
    requestAnimationFrame(() => editor.focus());
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
        await onSendSticker(
          roomId,
          image.url,
          image.body ?? image.shortcode,
          image.info,
          image.source_pack
        );
        error = null;
      } catch (cause) {
        console.debug('[sable composer] sticker failed', cause);
        error = failureText(cause);
      }
      return;
    }

    editor.insert(emoticonNode(image));
    typing.update(empty);
  }

  async function stage(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const targetRoom = roomId;
    const accountId = core.session?.account_id;
    const current = () => roomId === targetRoom && core.session?.account_id === accountId;

    try {
      const { upload_size } = await core.rpc.messages.mediaConfig();
      if (!current() || readOnly) return;
      const tooLarge = files.find((file) => file.size > upload_size);
      if (tooLarge) {
        error = i18n.t('composer.tooLarge', {
          name: tooLarge.name,
          limit: formatByteSize(upload_size),
        });
        return;
      }

      if (context?.kind === 'edit') {
        cancelContext();
        await tick();
      }

      error = null;
      staged = stageFiles(staged, files, () => nextStagedId++, preferences.imageMetadata);
      if (desktop) editor.focus();
    } catch (cause) {
      if (current()) {
        const failure = sendFailure(cause);
        error = i18n.t(failure.key, failure.values);
      }
    }
  }

  let picking = false;

  function pick(accept: string): void {
    if (picking) return;
    picking = true;
    void (async () => {
      try {
        const picked = await pickFiles(accept, () => {
          error = i18n.t('composer.pickFailed');
        });
        if (picked !== null) {
          await stage(picked);
          return;
        }

        if (!fileInput) return;
        fileInput.accept = accept;
        fileInput.removeAttribute('capture');
        fileInput.click();
      } finally {
        picking = false;
      }
    })();
  }

  function capture(accept: string): void {
    if (!fileInput) return;
    fileInput.accept = accept;
    fileInput.setAttribute('capture', 'environment');
    fileInput.click();
  }

  function stageFromInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    void stage(input.files ? Array.from(input.files) : []);
    input.value = '';
  }

  /** The servers cost a round trip, so the mention is inserted without them. */
  async function attachVia(address: string): Promise<void> {
    if (!address.startsWith('!')) return;
    try {
      editor.attachVia(address, await core.rpc.rooms.viaServers({ room_id: address }));
    } catch (error) {
      console.debug('[sable composer] via servers unavailable', error);
    }
  }

  function commit(suggestion: Suggestion): void {
    const current = query;
    if (!current) return;
    if (current.sigil === '+:') {
      if (quickReactEnabled) void quickReact(suggestion);
      return;
    }
    if (current.sigil !== '!') rememberSuggestion(suggestion.id);

    const slashBot =
      current.sigil === '/'
        ? slashBotCommands.find((command) => botCommandId(command) === suggestion.id)
        : undefined;
    if (slashBot && slashBot.parameters.length > 0) {
      const args = editor.text().replace(/^\/\S*/, '');
      editor.clear();
      openBotCommand(slashBot, args, '/');
      return;
    }
    const serverCommand =
      current.sigil === '!'
        ? serverCommands.find((command) => `${adminPrefix}${command.command}` === suggestion.id)
        : undefined;
    if (serverCommand && serverCommand.parameters.length > 0) {
      editor.clear();
      openBotCommand(serverCommand, '', adminPrefix);
      return;
    }

    editor.replaceQuery(current, suggestionNode(current.sigil, suggestion, sources.emotes));
    if (current.sigil === '#') void attachVia(suggestion.id);
    typing.update(empty);
  }

  async function quickReact(suggestion: Suggestion): Promise<void> {
    if (!onQuickReact) return;
    const target = roomId;
    const doc = editor.doc();
    const image = suggestion.id.startsWith('pack:')
      ? sources.emotes.find((candidate) => emoteSuggestionId(candidate) === suggestion.id)
      : undefined;
    editor.clear();
    typing.stop();
    error = null;
    try {
      await onQuickReact(target, image?.url ?? suggestion.insert, image?.source_pack ?? null);
      if (roomId === target && editor.isEmpty()) editor.clearHistory();
    } catch (cause) {
      if (roomId !== target) return;
      if (doc && editor.isEmpty()) editor.setDoc(doc);
      error = failureText(cause);
    }
  }

  const boardShortcuts: Array<[ShortcutId, BoardTab]> = [
    ['composer.toggleEmojiPicker', 'emoticon'],
    ['composer.toggleStickerPicker', 'sticker'],
    ['composer.toggleGifPicker', 'gif'],
  ];

  function canToggleBoard(event: KeyboardEvent): boolean {
    if (isDialogOpen()) return false;
    if (rowEl?.contains(event.target as Node | null)) return true;
    if (isEditableTarget(event.target) || document.querySelector(MENU_SELECTOR) !== null)
      return false;
    return !lastFocusedRow?.isConnected || lastFocusedRow === rowEl;
  }

  function toggleBoard(event: KeyboardEvent): boolean {
    if (!boardOpen && !canToggleBoard(event)) return false;

    for (const [id, tab] of boardShortcuts) {
      const binding = bindingFor(id);
      if (!binding || !matchesBinding(binding, event, isMacPlatform())) continue;
      if (tab === 'gif' && !onSendGif) return false;

      event.preventDefault();
      if (boardOpen && boardTab === tab) boardOpen = false;
      else {
        if (!desktop) blurEditor();
        boardTab = tab;
        boardOpen = true;
      }
      return true;
    }
    return false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (readOnly || event.defaultPrevented) return;
    if (toggleBoard(event)) return;
    if (!shouldFocusComposer(event)) return;

    editor.focus();
  }

  function stepReply(event: KeyboardEvent): void {
    if (
      !onReplyStep ||
      panelOpen ||
      context?.kind === 'edit' ||
      editingScheduled ||
      event.defaultPrevented
    )
      return;
    const direction = replyStep(event);
    if (!direction) return;

    event.preventDefault();
    onReplyStep(direction);
  }

  function stepEdit(event: KeyboardEvent): void {
    if (
      !onEditLast ||
      !onEditNext ||
      panelOpen ||
      editingScheduled ||
      event.defaultPrevented ||
      (context && context.kind !== 'edit') ||
      (!context && (!empty || staged.length > 0))
    )
      return;
    const direction = editStep(event);
    if (!direction) return;

    event.preventDefault();
    if (direction === 'older') onEditLast(context?.eventId);
    else if (context) onEditNext(context.eventId);
  }

  function navigate(key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean {
    if (!panelOpen) {
      if (
        key === 'ArrowUp' &&
        empty &&
        editor.isPristine() &&
        staged.length === 0 &&
        !context &&
        onEditLast
      ) {
        onEditLast();
        return true;
      }
      if (
        key === 'ArrowUp' &&
        context?.kind === 'edit' &&
        onEditLast &&
        prefilledDoc !== undefined &&
        editor.doc()?.eq(prefilledDoc) &&
        editor.atTopEdge()
      ) {
        onEditLast(context.eventId);
        return true;
      }
      if (
        key === 'ArrowDown' &&
        context?.kind === 'edit' &&
        onEditNext &&
        prefilledDoc !== undefined &&
        editor.doc()?.eq(prefilledDoc) &&
        editor.atBottomEdge()
      ) {
        onEditNext(context.eventId);
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
  onkeydown={handleKeydown}
  onmousemove={(event) => {
    if (pointerHidden && (event.movementX !== 0 || event.movementY !== 0)) pointerHidden = false;
  }}
/>

<ComposerDropZone {roomName} {readOnly} onFiles={stage} />

<div
  class={['composer-stack', { short: composerShort && !readOnly, 'pointer-hidden': pointerHidden }]}
>
  {#if readOnly}
    <div class="composer-shell">
      <div class="composer">
        <div class="composer-row">
          <p class="locked">{i18n.t('composer.readOnly')}</p>
        </div>
      </div>
    </div>
  {:else}
    <div class="composer-shell">
      <div class="composer" role="group" aria-label={i18n.t('timeline.messagePlaceholder')}>
        {#if context}
          <ComposerContextBanner {context} onCancel={cancelContext} {onToggleSilentReply} />
        {/if}
        {#if activeBotCommand}
          {#key activeBotCommand}
            <BotCommandForm
              command={activeBotCommand.command}
              drafts={activeBotCommand.drafts}
              {members}
              rooms={roomList.rooms}
              {sending}
              onCancel={closeBotCommand}
              prefix={activeBotCommand.prefix}
              onSubmit={(body: string, invocation: BotCommandInvocation) => {
                if (activeBotCommand)
                  void sendBotCommand(activeBotCommand.command, body, invocation);
              }}
            />
          {/key}
        {/if}
        {#if onDismissPreview && context?.kind !== 'edit' && shownLinks.length > 0}
          <ComposerLinkPreviews urls={shownLinks} onDismiss={onDismissPreview} />
        {/if}
        {#if error}
          <ComposerError
            message={error}
            onRetry={retry?.text === error ? retry.run : undefined}
            onDismiss={() => {
              error = null;
            }}
          />
        {/if}
        {#if staged.length > 0}
          <ComposerAttachments
            files={staged}
            disabled={sending}
            onRemove={(id: number) => {
              const index = staged.findIndex((item) => item.id === id);
              const removed = staged[index];
              staged = unstageFile(staged, id);
              if (!removed) return;
              toasts.undoable(i18n.t('composer.attachmentRemoved', { name: removed.file.name }), {
                label: i18n.t('common.undo'),
                onUndo: () => {
                  staged = restoreFile(staged, removed, index);
                },
              });
            }}
            onToggleSpoiler={(id: number) => {
              staged = toggleSpoiler(staged, id);
            }}
            onSetMetadata={(id: number, metadata: ImageMetadata) => {
              staged = setMetadata(staged, id, metadata);
            }}
          />
        {/if}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          class={['composer-row', { short: shortLayout, 'formatting-open': formattingOpen }]}
          hidden={activeBotCommand !== null}
          bind:this={rowEl}
          onmousedown={focusFromRow}
          onfocusin={() => (lastFocusedRow = rowEl)}
          onkeydown={(event) => {
            stepReply(event);
            stepEdit(event);
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) pointerHidden = true;
          }}
          onsubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {#if recording}
            <VoiceRecorder
              onSend={(file: File) => {
                void sendVoice(file);
              }}
              onCancel={() => {
                void stopRecording();
              }}
            />
          {:else}
            {#snippet personaButton()}
              <PersonaPicker
                {roomId}
                onBeforeOpen={!desktop ? blurEditor : undefined}
                edit={context?.kind === 'edit' && onEditPersona
                  ? { current: context.persona ?? null, onChoose: onEditPersona }
                  : undefined}
                shorthandHint={shorthandHint ?? undefined}
              />
            {/snippet}
            <div class="composer-before" bind:this={beforeEl}>
              <ComposerDoor
                {desktop}
                onPick={pick}
                onCapture={capturesFromCamera() ? capture : undefined}
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
                onSchedule={canSchedule
                  ? () => {
                      scheduleOpen = true;
                    }
                  : undefined}
                onVoice={canVoice && !showVoice ? startRecording : undefined}
                onBeforeOpen={!desktop ? blurEditor : undefined}
                extras={{
                  ...(showPersonaPicker &&
                    preferences.personaPickerLeftSide && { persona: personaButton }),
                }}
              />
            </div>
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
            <ComposerField {editor} {showPlaceholder} {placeholder} bind:expanded />
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
            {#snippet formatButton()}
              <Tooltip label={i18n.t('composer.formatting')}>
                {#snippet trigger({ props })}
                  <IconButton
                    {...mergeProps(props, {
                      onclick: () => {
                        setPreference('formattingToolbar', !formattingOpen);
                      },
                    })}
                    variant="ghost"
                    size="small"
                    class="composer-format selection-open"
                    aria-pressed={formattingOpen}
                    data-state={formattingOpen ? 'open' : 'closed'}
                    label={i18n.t('composer.formatting')}
                  >
                    <TextAaIcon />
                  </IconButton>
                {/snippet}
              </Tooltip>
            {/snippet}
            <div class="composer-after" bind:this={afterEl}>
              <ComposerBoard
                {roomId}
                {desktop}
                bind:open={boardOpen}
                bind:tab={boardTab}
                bind:query={boardQuery}
                onPick={pickFromBoard}
                onPickUnicode={pickUnicodeFromBoard}
                onPickGif={onSendGif ? pickGifFromBoard : undefined}
                onBeforeOpen={!desktop ? blurEditor : undefined}
                onPicked={desktop ? focusEditorAfterPick : undefined}
                extras={{
                  ...(showPersonaPicker &&
                    !preferences.personaPickerLeftSide && { persona: personaButton }),
                  ...(preferences.composerFormatButton && { format: formatButton }),
                }}
              />
              {#if showVoice}
                <Tooltip label={i18n.t('composer.voiceRecord')}>
                  {#snippet trigger({ props })}
                    <IconButton
                      {...mergeProps(props, {
                        onclick: startRecording,
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
              {/if}
              <ComposerSendButton
                {context}
                {hasContent}
                canDelete={canDeleteEdited}
                {canSchedule}
                {sending}
                {desktop}
                shortcut={sendShortcut}
                onSchedule={() => {
                  scheduleOpen = true;
                }}
              />
            </div>
          {/if}
        </form>
        {#if panelOpen && query}
          <ComposerAutocomplete
            id={listboxId}
            {optionId}
            heading={query.sigil === '@'
              ? i18n.t('composer.membersHeading', { query: query.query })
              : query.sigil === '#'
                ? i18n.t('composer.roomsHeading', { query: query.query })
                : query.sigil === '+:'
                  ? i18n.t('timeline.addReaction')
                  : query.sigil === ':'
                    ? i18n.t('composer.emotesHeading', { query: query.query })
                    : i18n.t('composer.commandsHeading', { query: query.query })}
            {suggestions}
            {active}
            onSelect={commit}
          />
        {/if}
        <div class="composer-measurer" bind:this={measurerEl} aria-hidden="true"></div>
        <p class="screen-reader-only" id={hintId}>{keyboardHint}</p>
        <p class="screen-reader-only" aria-live="polite">{contextAnnouncement}</p>
      </div>
    </div>
  {/if}
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

{#if onSchedule}
  <ScheduleComposer
    bind:open={scheduleOpen}
    empty={!hasContent || readOnly}
    attachmentsBlocked={staged.length > 0 && encrypted !== false}
    {encrypted}
    dueTs={context?.scheduled?.dueTs ?? null}
    onSchedule={(dueTs: number) => {
      void scheduleDraft(dueTs);
    }}
  />
{/if}

{#if onCreatePoll}
  <PollComposer
    bind:open={pollOpen}
    onCreate={(
      question: string,
      answers: string[],
      undisclosed: boolean,
      maxSelections?: number
    ) => {
      void onCreatePoll(roomId, question, answers, undisclosed, maxSelections);
    }}
  />
{/if}

{#if deleteEditOpen}
  <DeleteMessageDialog
    bind:open={deleteEditOpen}
    preview={deleteEditTarget?.body ?? null}
    onConfirm={confirmDeleteEdit}
  />
{/if}

<ComposerLinkDialog
  bind:open={linkDialogOpen}
  onApply={(href: string) => {
    editor.applyLink(href);
  }}
/>

<ComposerSpoilerDialog
  bind:open={spoilerDialogOpen}
  onApply={(reason: string) => {
    editor.applySpoiler(reason);
  }}
/>

<style>
  .composer-measurer {
    box-sizing: border-box;
    height: 0;
    overflow: hidden;
    overflow-wrap: break-word;
    pointer-events: none;
    position: absolute;
    visibility: hidden;
    white-space: pre-wrap;
  }

  .locked {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: max(var(--font-size-editor), var(--font-size-input-min));
    grid-column: 1 / -1;
    justify-content: center;
    margin: 0;
    min-height: var(--target);
    padding: var(--space-200) var(--space-300);
  }

  .composer-file {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }
</style>
