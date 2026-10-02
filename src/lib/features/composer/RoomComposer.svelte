<script lang="ts">
  import type {
    ImageUsageView,
    MemberView,
    PackImageInfoView,
    ImageSourcePackView,
    PackImageView,
  } from '#src/generated/protocol';
  import { mergeProps, Portal } from 'bits-ui';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import ArrowsInSimpleIcon from 'phosphor-svelte/lib/ArrowsInSimpleIcon';
  import ArrowsOutSimpleIcon from 'phosphor-svelte/lib/ArrowsOutSimpleIcon';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';
  import { onDestroy, tick, untrack } from 'svelte';

  import type { OutgoingMentions } from '#lib/core/client.svelte.js';
  import type { SendAttachmentOptions } from '#lib/core/commands.svelte.js';
  import type { SendGalleryOptions } from '#lib/core/commands.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import type { ConversationSendResult } from '#lib/features/room/conversation/conversation.svelte.js';
  import type { ReplyDirection } from '#lib/features/room/timeline/timeline-format.js';
  import DeleteMessageDialog from '#lib/features/room/messages/DeleteMessageDialog.svelte';
  import { LongPress, SCHEDULE_PRESS_MS, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { isPackChange, loadPacks } from '#lib/emoji/load-packs.js';
  import { listenNativeFileDrop } from '#lib/platform/file-drop.js';
  import { pickFiles } from '#lib/platform/files.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { REORDER_DRAG_TYPE } from '#lib/ui/drag-list.js';
  import { matchesBinding } from '#lib/ui/shortcuts/binding.js';
  import { effectiveShortcuts } from '#lib/ui/shortcuts/bindings.svelte.js';
  import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import BotCommandForm from './BotCommandForm.svelte';
  import ComposerAttachments from './ComposerAttachments.svelte';
  import ComposerAutocomplete from './ComposerAutocomplete.svelte';
  import type { GifResult } from '#lib/features/gif/providers.js';
  import ComposerBoard from './ComposerBoard.svelte';
  import ComposerContextBanner from './ComposerContextBanner.svelte';
  import ComposerError from './ComposerError.svelte';
  import ComposerDoor from './ComposerDoor.svelte';
  import PersonaPicker from './PersonaPicker.svelte';
  import PollComposer from './PollComposer.svelte';
  import ComposerFormatting from './ComposerFormatting.svelte';
  import ComposerLinkDialog from './ComposerLinkDialog.svelte';
  import ComposerSpoilerDialog from './ComposerSpoilerDialog.svelte';
  import LocationComposer from './LocationComposer.svelte';
  import ScheduleComposer from './ScheduleComposer.svelte';
  import type { AutocompleteQuery, Suggestion } from './autocomplete';
  import { formattedForEditing, type ComposerContext } from './composer-context';
  import { clearDraft, readDraft, remoteRevision, writeDraft } from './composer-drafts.svelte';
  import {
    filesFrom,
    restoreFile,
    stageFiles,
    toggleSpoiler,
    unstageFile,
    type StagedFile,
  } from './composer-files';
  import { shouldFocusComposer } from './type-to-focus';
  import ComposerEditorView from './editor/ComposerEditor.svelte';
  import { ComposerEditor } from './editor/composer-editor';
  import type { ActiveColors, ColorKind, FormatAction } from './editor/formatting';
  import type { EmoteMedia } from './editor/node-views';
  import { composerSchema } from './editor/schema';
  import type { BoardTab } from '#lib/ui/primitives/emote-board.js';
  import {
    commandTextOf,
    plainEditDoc,
    serializeComposer,
    serializePlain,
  } from './editor/serialize';
  import { isServerScheduleUnsupported, ScheduledOriginalKept, sendFailure } from './send-failure';
  import { SendQueue } from './send-queue';
  import {
    ADMIN_PREFIX,
    adminBot,
    adminBotCommands,
    adminCommandTree,
    adminScope,
    loadAdminCommands,
    type AdminCommand,
  } from './admin-commands';
  import {
    botCommandId,
    buildInvocation,
    draftsFromText,
    matchBotCommand,
    parseBotCommands,
    type ArgumentDrafts,
    type BotCommand,
    type BotCommandInvocation,
  } from './bot-commands';
  import { parseSlash } from './slash-commands';
  import { ROOM_MENTION, suggestionsFor } from './suggestions';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import { isVoiceRecordingSupported } from './voice-recorder-support';

  interface Props {
    roomId: string;
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
    /** What the next send relates to: a message being replied to, or edited. */
    context?: ComposerContext | null;
    onCancelContext?: () => void;
    onToggleSilentReply?: () => void;
    onDeleteEdited?: (eventId: string, reason: string | null) => void;
    onEditLast?: (before?: string) => void;
    onEditNext?: (after: string) => void;
    onReplyStep?: (direction: ReplyDirection) => void;
    threadRoot?: string | null;
  }

  let {
    roomId,
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
    context = null,
    onCancelContext,
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
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const uid = $props.id();
  const hintId = `composer-hint-${uid}`;
  const listboxId = `composer-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  const DRAFT_PERSIST_MS = 500;
  const draftKey = (): string => (threadRoot === null ? roomId : `${roomId}/${threadRoot}`);

  let prefilledFor: string | null = null;
  let activeDraftKey = $state<string | null>(null);
  let nextStagedId = 0;
  let preEdit: ProseMirrorNode | undefined;
  let prefilledDoc: ProseMirrorNode | undefined;
  let loadedMembersFor = $state<string | null>(null);
  let loadedEmotesFor = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let draftTimeout: ReturnType<typeof setTimeout> | undefined;
  let seenRemoteDraft = 0;
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

  let staged = $state<StagedFile[]>([]);
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
  let layoutFrame: number | undefined;
  let empty = $state(true);
  let showPlaceholder = $state(true);
  let activeFormats = $state.raw<FormatAction[]>([]);
  let activeColors = $state.raw<ActiveColors>({ fg: null, bg: null });
  let formattingOpen = $derived(preferences.formattingToolbar);
  let richText = $derived(preferences.richTextComposer);
  let richSend = $derived(richText && !sourceMode);
  let configuredRich = preferences.richTextComposer;
  let dragging = $state(false);
  let dropTarget = $derived(roomName ?? $i18n.t('timeline.thisRoom'));
  let query = $state.raw<AutocompleteQuery | null>(null);
  let dismissedAt = $state<number | null>(null);
  let activeIndex = $state(0);
  let previousContext: ComposerContext | null = null;
  let deleteEditTarget = $state.raw<ComposerContext | null>(null);
  let members = $state.raw<MemberView[]>([]);
  let emotes = $state.raw<PackImageView[]>([]);
  let emotesFor: string | null = null;
  let botCommands = $state.raw<BotCommand[]>([]);
  let loadedBotCommandsFor = $state<string | null>(null);
  let botCommandsFor: string | null = null;
  let activeBotCommand = $state.raw<{
    command: BotCommand;
    drafts: ArgumentDrafts;
    prefix: string;
  } | null>(null);

  let desktop = $derived(appLayout.matches);
  let sending = $derived(inFlight > 0);
  let editingCaption = $derived(context?.kind === 'edit' && context.mediaCaption === true);
  let hasContent = $derived(!empty || staged.length > 0 || editingCaption);
  let canDeleteEdited = $derived(context?.kind === 'edit' && onDeleteEdited !== undefined);
  let editingScheduled = $derived(context?.kind === 'schedule');
  let showVoice = $derived(context?.kind !== 'edit' && !editingScheduled && voiceSupported);
  let sendLabel = $derived(
    editingScheduled
      ? $i18n.t('composer.scheduledSave')
      : context?.kind === 'edit'
        ? !hasContent && canDeleteEdited
          ? $i18n.t('timeline.deleteMessage')
          : $i18n.t('composer.saveChanges')
        : $i18n.t('timeline.sendMessage')
  );
  let contextAnnouncement = $derived(
    context?.kind === 'edit'
      ? $i18n.t('composer.editing')
      : context?.kind === 'schedule'
        ? $i18n.t('composer.editingScheduled')
        : context?.kind === 'reply'
          ? $i18n.t('composer.replyingTo', { name: context.sender ?? '' })
          : ''
  );
  let showPersonaPicker = $derived(preferences.personaPicker && personas.personas.length > 0);

  let canSchedule = $derived(onSchedule !== undefined && hasContent && !readOnly);
  let sendShortcut = $derived(preferences.enterForNewline ? 'Shift+Enter' : 'Enter');
  let keyboardHint = $derived(
    $i18n.t(
      !hasContent && canDeleteEdited
        ? 'composer.deleteHint'
        : context?.kind === 'edit' || editingScheduled
          ? 'composer.editHint'
          : 'composer.sendHint',
      {
        shortcut: sendShortcut,
        newline: preferences.enterForNewline ? 'Enter' : 'Shift+Enter',
      }
    )
  );
  let sendTooltip = $derived(
    desktop
      ? $i18n.t(canSchedule ? 'composer.sendScheduleTooltip' : 'composer.sendTooltip', {
          action: sendLabel,
          shortcut: sendShortcut,
        })
      : canSchedule
        ? $i18n.t('composer.scheduleTooltip', { action: sendLabel })
        : sendLabel
  );

  const sendPress = new LongPress({
    enabled: () => canSchedule,
    delayMs: SCHEDULE_PRESS_MS,
    onPress: () => {
      scheduleOpen = true;
    },
  });

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
  let adminCommands = $state.raw<readonly AdminCommand[] | null>(null);
  let botCommandsEnabled = $derived(
    onSendBotCommand !== undefined && context?.kind !== 'edit' && !editingScheduled
  );
  let offeredBotCommands = $derived(botCommandsEnabled ? botCommands : []);
  let serverBot = $derived(
    admin === 'adminRoom' && core.session ? adminBot(core.session.user_id) : null
  );
  let adminPrefix = $derived(admin === 'escaped' ? `\\${ADMIN_PREFIX} ` : `${ADMIN_PREFIX} `);
  let advertisedAdminCommands = $derived(
    offeredBotCommands.filter((command) => command.sender === serverBot)
  );
  let serverCommands = $derived.by(() => {
    if (advertisedAdminCommands.length > 0) return advertisedAdminCommands;
    if (!botCommandsEnabled || !admin || !adminCommands || !core.session) return [];
    return adminBotCommands(adminCommands, adminBot(core.session.user_id), admin);
  });
  let slashBotCommands = $derived(
    offeredBotCommands.filter((command) => command.sender !== serverBot)
  );
  let suggestions = $derived(
    suggestionsFor(
      query,
      members,
      emotes,
      roomList.rooms,
      $i18n.t,
      admin,
      advertisedAdminCommands.length > 0
        ? adminCommandTree(advertisedAdminCommands)
        : adminCommands,
      slashBotCommands
    )
  );

  $effect(() => {
    if (!onSendBotCommand) return;
    const target = roomId;
    return core.subscribeEvents((event) => {
      if (event.type === 'bot_commands_changed' && event.room_id === target) {
        loadedBotCommandsFor = null;
        botCommandsFor = null;
        botCommands = [];
      }
    });
  });

  $effect(() => {
    void roomId;
    activeBotCommand = null;
  });

  $effect(() =>
    core.subscribeEvents((event) => {
      if (!isPackChange(event)) return;
      loadedEmotesFor = null;
      if (query?.sigil === ':' || query?.sigil === '+:') void loadEmotes();
    })
  );

  async function loadAdminCatalog(): Promise<void> {
    if (adminCommands) return;
    try {
      adminCommands = await loadAdminCommands();
    } catch (error) {
      console.warn('[sable composer] loading admin commands failed', error);
    }
  }

  $effect(() => {
    if (query?.sigil === '!' && admin && !adminCommands) void loadAdminCatalog();
  });
  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));
  let placeholder = $derived(
    staged.length > 0
      ? $i18n.t(
          staged.length === 1 && preferences.sendAttachmentAsCaption
            ? 'composer.addCaptionOrSend'
            : 'composer.addMessageOrSend'
        )
      : context?.kind === 'reply' && context.sender
        ? $i18n.t('composer.replyPlaceholder', { name: context.sender })
        : roomName
          ? $i18n.t('composer.roomPlaceholder', { room: roomName })
          : $i18n.t('timeline.messagePlaceholder')
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
    emotes: () => emotes,
    label: () => $i18n.t('timeline.messagePlaceholder'),
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
        updateTyping();
        scheduleLayout();
        schedulePersistDraft();
      }
    },
    onQuery: (next) => {
      if (!next) dismissedAt = null;
      query = next;
      if (next?.sigil === '@') void loadMembers();
      if (next?.sigil === ':' || next?.sigil === '+:') void loadEmotes();
      if (next?.sigil === '/' || (next?.sigil === '!' && admin === 'adminRoom')) {
        void loadBotCommands();
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

  let activeDraftAccount = '';

  function persistDraft(key: string): void {
    const doc = preEdit ?? (editor.isEmpty() ? undefined : editor.doc());
    if (!doc && staged.length === 0) clearDraft(key, activeDraftAccount);
    else writeDraft(key, { doc: doc?.toJSON() ?? null, staged, nextStagedId }, activeDraftAccount);
  }

  function schedulePersistDraft(): void {
    clearTimeout(draftTimeout);
    draftTimeout = setTimeout(() => {
      draftTimeout = undefined;
      if (activeDraftKey !== null) persistDraft(activeDraftKey);
    }, DRAFT_PERSIST_MS);
  }

  $effect(() => {
    const key = draftKey();
    const accountId = core.session?.account_id ?? '';
    if (activeDraftKey === key && activeDraftAccount === accountId) return;
    const previous = activeDraftKey;
    clearTimeout(draftTimeout);
    draftTimeout = undefined;
    if (previous !== null) untrack(() => persistDraft(previous));
    if (activeDraftAccount !== accountId) preEdit = undefined;
    activeDraftKey = key;
    activeDraftAccount = accountId;

    untrack(() => {
      seenRemoteDraft = remoteRevision(key, core.session?.account_id ?? '');
      const draft = readDraft(key, activeDraftAccount);
      if (draft) {
        staged = draft.staged;
        nextStagedId = draft.nextStagedId;
        editor.clear();
        if (draft.doc) editor.setDoc(composerSchema.nodeFromJSON(draft.doc));
      } else if (previous !== null) {
        staged = [];
        nextStagedId = 0;
        editor.clear();
      }
    });
  });

  onDestroy(() => {
    sendPress.cancel();
    if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
    if (typingTimeout) clearTimeout(typingTimeout);
    clearTimeout(draftTimeout);
    stopTyping();
    queue.dispose();
    if (activeDraftKey !== null) persistDraft(activeDraftKey);
  });

  $effect(() => {
    const key = draftKey();
    const revision = remoteRevision(key, core.session?.account_id ?? '');
    untrack(() => {
      if (activeDraftKey !== key || revision === seenRemoteDraft) return;
      seenRemoteDraft = revision;
      if (draftTimeout !== undefined || preEdit !== undefined) return;

      const draft = readDraft(key, activeDraftAccount);
      editor.clear();
      if (draft?.doc) editor.setDoc(composerSchema.nodeFromJSON(draft.doc));
    });
  });

  $effect(() => {
    if (
      (context?.kind === 'edit' || context?.kind === 'schedule') &&
      prefilledFor !== context.eventId
    ) {
      if (prefilledFor === null && !editor.isEmpty()) preEdit = editor.doc();
      prefilledFor = context.eventId;
      const formatted = formattedForEditing(context.html);
      if (formatted === null) editor.setText(context.body);
      else if (richText) editor.setHtml(formatted);
      else editor.setDoc(plainEditDoc(context.body, formatted));
      prefilledDoc = editor.doc();
    } else if (context === null) {
      const wasEditing = prefilledFor !== null;
      prefilledFor = null;
      prefilledDoc = undefined;
      if (preEdit) {
        editor.setDoc(preEdit);
        preEdit = undefined;
      } else if (wasEditing) {
        editor.clear();
      }
    }
  });

  $effect(() => {
    if (context === previousContext) return;

    const wasActive = previousContext !== null;
    const wasEditing = previousContext?.kind === 'edit' || previousContext?.kind === 'schedule';
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
    const target = roomId;
    loadedEmotesFor = target;
    if (emotesFor !== target) emotes = [];
    try {
      const complete = await loadPacks(
        core.commands,
        target,
        (packs) => {
          if (roomId !== target) return;
          emotesFor = target;
          emotes = packs
            .flatMap((pack) => pack.images)
            .filter((image) => image.usage.includes('emoticon'));
        },
        core.session?.account_id ?? null
      );
      if (!complete && loadedEmotesFor === target) loadedEmotesFor = null;
    } catch {
      if (roomId === target) loadedEmotesFor = null;
    }
  }

  async function loadBotCommands(): Promise<void> {
    if (!onSendBotCommand || loadedBotCommandsFor === roomId) return;
    const target = roomId;
    loadedBotCommandsFor = target;
    if (botCommandsFor !== target) botCommands = [];
    try {
      const commands = parseBotCommands(await core.commands.botCommands(target));
      if (roomId !== target) return;
      botCommandsFor = target;
      botCommands = commands;
    } catch (error) {
      console.debug('[sable composer] bot commands unavailable', error);
      if (loadedBotCommandsFor === target) loadedBotCommandsFor = null;
    }
  }

  function openBotCommand(command: BotCommand, args: string, prefix: string): void {
    activeBotCommand = { command, drafts: draftsFromText(command, args), prefix };
    error = null;
    void loadMembers();
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
    await Promise.all([loadBotCommands(), admin ? loadAdminCatalog() : undefined]);
    if (roomId !== targetRoomId || (doc && !editor.doc()?.eq(doc))) return true;
    const typed = text.startsWith('/')
      ? { line: text.slice(1), prefix: '/', commands: slashBotCommands }
      : { line: text.slice(adminPrefix.length), prefix: adminPrefix, commands: serverCommands };
    const matched = matchBotCommand(typed.line, typed.commands);
    if (!matched) return false;

    editor.clear();
    if (matched.command.parameters.length === 0 && matched.args !== '') {
      const body = `${typed.prefix}${matched.command.command}${matched.rawArgs}`;
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
    if (result.ok) {
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

  function failRetryably(cause: unknown, run: () => void): void {
    const failure = sendFailure(cause);
    error = $i18n.t(failure.key, failure.values);
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
    const rich = richSend;
    const captionEdit = editingCaption;
    const asCaption = preferences.sendAttachmentAsCaption;
    let unsent = staged;

    inFlight += 1;
    error = null;
    editor.clear();
    sourceMode = editor.leaveSource();
    staged = [];
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();

    try {
      await queue.enqueue(async () => {
        const message = doc
          ? rich
            ? serializeComposer(doc)
            : serializePlain(doc)
          : {
              body: '',
              formatted: null,
              mentions: { userIds: [], room: false },
              imageSourcePacks: [],
            };
        const captioned = asCaption && unsent.length === 1 && message.body !== '';
        const gallery =
          preferences.sendAttachmentsAsGallery &&
          onSendGallery !== undefined &&
          unsent.length > 1 &&
          unsent.every((item) => !item.spoiler);

        if (gallery) {
          await onSendGallery(
            roomId,
            unsent.map((item) => item.file),
            {
              caption: message.body || null,
              formattedCaption: message.formatted,
              mentions: message.mentions,
            }
          );
          unsent = [];
          return;
        }

        while (unsent.length > 0) {
          const [next, ...rest] = unsent;
          await onSendAttachment(
            roomId,
            next.file,
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
      error = $i18n.t('composer.scheduleAttachmentEncrypted');
      return;
    }

    const attachments = staged;
    const delayIds: string[] = [];

    editor.clear();
    staged = [];
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();

    try {
      for (const attachment of attachments) {
        delayIds.push(
          await core.commands.scheduleAttachment(roomId, attachment.file, dueTs, attachment.spoiler)
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
        delayIds.map((delayId) => core.commands.cancelScheduledMessage(delayId))
      );
      if (cause instanceof ScheduledOriginalKept) {
        editor.clearHistory();
        error = $i18n.t('composer.scheduledOriginalKept');
        return;
      }
      if (doc && editor.isEmpty()) editor.setDoc(doc);
      staged = [...attachments, ...staged];
      error = $i18n.t(
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
    updateTyping();
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

    editor.insert(
      composerSchema.nodes.emoticon.create({
        url: image.url,
        body: image.body,
        shortcode: image.shortcode,
        sourcePack: image.source_pack,
      })
    );
    updateTyping();
  }

  async function stage(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const targetRoom = roomId;
    const accountId = core.session?.account_id;
    const current = () => roomId === targetRoom && core.session?.account_id === accountId;

    try {
      const { upload_size } = await core.commands.mediaConfig();
      if (!current() || readOnly) return;
      const tooLarge = files.find((file) => file.size > upload_size);
      if (tooLarge) {
        error = $i18n.t('composer.tooLarge', {
          name: tooLarge.name,
          limit: formatByteSize(upload_size),
        });
        return;
      }

      error = null;
      staged = stageFiles(staged, files, () => nextStagedId++);
    } catch (cause) {
      if (current()) {
        const failure = sendFailure(cause);
        error = $i18n.t(failure.key, failure.values);
      }
    }
  }

  function pick(accept: string): void {
    void (async () => {
      const picked = await pickFiles(accept);
      if (picked !== null) {
        await stage(picked);
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
    void stage(input.files ? Array.from(input.files) : []);
    input.value = '';
  }

  function reorderDrag(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes(REORDER_DRAG_TYPE) ?? false;
  }

  function handleDrop(event: DragEvent): void {
    dragging = false;
    if (event.defaultPrevented || readOnly || reorderDrag(event)) return;

    const files = filesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void stage(files);
  }

  function handleDragover(event: DragEvent): void {
    if (readOnly || reorderDrag(event) || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragging = true;
  }

  function handleDragleave(event: DragEvent): void {
    if (event.relatedTarget !== null) return;
    dragging = false;
  }

  $effect(() =>
    listenNativeFileDrop({
      onEnter: () => (dragging = !readOnly),
      onLeave: () => (dragging = false),
      onDrop: (files) => {
        if (!readOnly) void stage(files);
      },
    })
  );

  function nodeFor(sigil: string, suggestion: Suggestion): ProseMirrorNode {
    if (sigil === '/' || sigil === '!') return composerSchema.text(suggestion.insert);

    if (sigil === '@') {
      if (suggestion.id === ROOM_MENTION) return composerSchema.nodes.room_ping.create();
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
    if (current.sigil === '+:') {
      if (quickReactEnabled) void quickReact(suggestion);
      return;
    }

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

    editor.replaceQuery(current, nodeFor(current.sigil, suggestion));
    if (current.sigil === '#') void attachVia(suggestion.id);
    updateTyping();
  }

  async function quickReact(suggestion: Suggestion): Promise<void> {
    if (!onQuickReact) return;
    const target = roomId;
    const doc = editor.doc();
    const image = suggestion.id.startsWith('pack:')
      ? emotes.find((candidate) => `pack:${candidate.shortcode}` === suggestion.id)
      : undefined;
    editor.clear();
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();
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

  function handleKeydown(event: KeyboardEvent): void {
    if (readOnly || event.defaultPrevented) return;
    if (!shouldFocusComposer(event)) return;

    editor.focus();
  }

  const REPLY_STEPS: Partial<Record<string, ReplyDirection>> = {
    'room.replyOlder': 'older',
    'room.replyNewer': 'newer',
  };

  function stepReply(event: KeyboardEvent): void {
    if (
      !onReplyStep ||
      panelOpen ||
      context?.kind === 'edit' ||
      editingScheduled ||
      event.defaultPrevented
    )
      return;
    const isMac = isMacPlatform();
    const shortcut = effectiveShortcuts().find(
      (candidate) => REPLY_STEPS[candidate.id] && matchesBinding(candidate.binding, event, isMac)
    );
    const direction = shortcut && REPLY_STEPS[shortcut.id];
    if (!direction) return;

    event.preventDefault();
    onReplyStep(direction);
  }

  function navigate(key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'): boolean {
    if (!panelOpen) {
      if (key === 'ArrowUp' && empty && staged.length === 0 && !context && onEditLast) {
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
              toasts.undoable($i18n.t('composer.attachmentRemoved', { name: removed.file.name }), {
                label: $i18n.t('composer.undo'),
                onUndo: () => {
                  staged = restoreFile(staged, removed, index);
                },
              });
            }}
            onToggleSpoiler={(id: number) => {
              staged = toggleSpoiler(staged, id);
            }}
          />
        {/if}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          class="composer-row"
          class:formatting-open={formattingOpen}
          hidden={activeBotCommand !== null}
          bind:this={rowEl}
          onmousedown={focusFromRow}
          onkeydown={stepReply}
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
            <div class="composer-before" bind:this={beforeEl}>
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
                onSchedule={canSchedule
                  ? () => {
                      scheduleOpen = true;
                    }
                  : undefined}
                onBeforeOpen={!desktop ? blurEditor : undefined}
              />
            </div>
            <p class="composer-keyboard-hint" aria-hidden="true">{keyboardHint}</p>
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
              <ComposerEditorView {editor} {showPlaceholder} {placeholder} {expanded} />
              <Tooltip label={$i18n.t(expanded ? 'composer.collapse' : 'composer.expand')}>
                {#snippet trigger({ props })}
                  <IconButton
                    {...mergeProps(props, {
                      onclick: () => {
                        expanded = !expanded;
                        editor.focus();
                      },
                    })}
                    variant="ghost"
                    size="small"
                    class="composer-expand"
                    aria-pressed={expanded}
                    label={$i18n.t('composer.expand')}
                  >
                    {#if expanded}<ArrowsInSimpleIcon />{:else}<ArrowsOutSimpleIcon />{/if}
                  </IconButton>
                {/snippet}
              </Tooltip>
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
            {#snippet personaButton()}
              <PersonaPicker {roomId} onBeforeOpen={!desktop ? blurEditor : undefined} />
            {/snippet}
            {#snippet formatButton()}
              <Tooltip label={$i18n.t('composer.formatting')}>
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
                    label={$i18n.t('composer.formatting')}
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
                extras={{
                  ...(showPersonaPicker && { persona: personaButton }),
                  ...(preferences.composerFormatButton && { format: formatButton }),
                }}
              />
              {#if showVoice}
                <Tooltip label={$i18n.t('composer.voiceRecord')}>
                  {#snippet trigger({ props })}
                    <IconButton
                      {...mergeProps(props, {
                        onclick: startRecording,
                      })}
                      variant="ghost"
                      size="small"
                      class="composer-voice"
                      label={$i18n.t('composer.voiceRecord')}
                    >
                      <MicrophoneIcon />
                    </IconButton>
                  {/snippet}
                </Tooltip>
              {/if}
              <Tooltip label={sendTooltip}>
                {#snippet trigger({ props })}
                  <IconButton
                    {...mergeProps(props, {
                      onpointerdown: sendPress.start,
                      onpointermove: sendPress.move,
                      onpointerup: sendPress.lift,
                      onkeydown: (event: KeyboardEvent) => {
                        if (
                          event.key === 'ContextMenu' ||
                          (event.key === 'F10' && event.shiftKey)
                        ) {
                          sendPress.touch = false;
                        }
                      },
                    })}
                    type="submit"
                    variant="ghost"
                    size="small"
                    class="composer-send"
                    data-pressing={sendPress.pressing || undefined}
                    style="--press-ms: {SCHEDULE_PRESS_MS}ms"
                    disabled={!hasContent && !canDeleteEdited}
                    label={sendLabel}
                    onpointercancel={sendPress.end}
                    oncontextmenu={(event: MouseEvent) => {
                      if (sendPress.touch || touchContextMenu(event)) {
                        event.preventDefault();
                        return;
                      }
                      if (!canSchedule) return;
                      event.preventDefault();
                      scheduleOpen = true;
                    }}
                    onmousedown={(event: MouseEvent) => {
                      if (hasContent) event.preventDefault();
                    }}
                  >
                    {#if sending}
                      <Spinner small />
                    {:else if context?.kind === 'edit' || editingScheduled}
                      {#if !hasContent && canDeleteEdited}
                        <TrashIcon />
                      {:else}
                        <CheckIcon weight="bold" />
                      {/if}
                    {:else}
                      <PaperPlaneIcon weight="fill" />
                    {/if}
                  </IconButton>
                {/snippet}
              </Tooltip>
            </div>
          {/if}
        </form>
        {#if panelOpen && query}
          <ComposerAutocomplete
            id={listboxId}
            {optionId}
            heading={query.sigil === '@'
              ? $i18n.t('composer.membersHeading', { query: query.query })
              : query.sigil === '#'
                ? $i18n.t('composer.roomsHeading', { query: query.query })
                : query.sigil === '+:'
                  ? $i18n.t('timeline.addReaction')
                  : query.sigil === ':'
                    ? $i18n.t('composer.emotesHeading', { query: query.query })
                    : $i18n.t('composer.commandsHeading', { query: query.query })}
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
  .composer-stack {
    --composer-gutter: var(--space-200);
    --target: var(--control-height-small);

    margin: 0 auto;
    position: relative;
    width: calc(100% - var(--composer-gutter) - var(--composer-gutter));
  }

  @media (pointer: coarse) {
    .composer-stack {
      --target: var(--control-height-400);
    }

    .composer-stack :global(.icon-button-small) {
      --button-height: var(--target);
    }
  }

  @media (width >= 32rem) {
    .composer-stack {
      --composer-gutter: var(--page-gutter);
    }

    .composer-row {
      gap: var(--space-200);
    }
  }

  .composer-shell {
    align-items: end;
    display: flex;
    position: relative;
  }

  .composer {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    container-type: inline-size;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    min-width: 0;
    position: relative;
    width: 100%;
  }

  .composer:has(:global([contenteditable='true']):focus) {
    border-color: var(--primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
  }

  .drop-overlay {
    align-items: center;
    background: var(--overlay);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: var(--space-400);
    pointer-events: none;
    position: fixed;
    z-index: var(--layer-overlay);
  }

  .drop-card {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) dashed var(--primary-main);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    color: var(--primary-main);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    max-width: min(28rem, 100%);
    padding: var(--space-600) var(--space-500);
    text-align: center;
  }

  .drop-title {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .composer-row {
    align-items: center;
    display: grid;
    gap: var(--space-100);
    grid-template-areas:
      'field field field'
      'before hint after';
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: var(--space-100);
    width: 100%;
  }

  .composer-row[hidden] {
    display: none;
  }

  .composer-row.formatting-open {
    grid-template-areas:
      'field field field'
      'before formatting after';
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .composer-formatting {
    grid-area: formatting;
    min-width: 0;
  }

  .composer-before,
  .composer-after {
    align-items: center;
    display: flex;
    gap: var(--space-100);
  }

  @container (width < 24rem) {
    .composer-row {
      grid-template-areas:
        'field field'
        'before after';
      grid-template-columns: auto minmax(0, 1fr);
    }

    .composer-row.formatting-open {
      grid-template-areas:
        'field field'
        'formatting formatting'
        'before after';
    }

    .composer-after {
      flex-wrap: wrap;
      gap: 0;
      justify-content: end;
      min-width: 0;
    }
  }

  .composer-row > :global(.voice-recorder) {
    grid-column: 1 / -1;
  }

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

  .composer-field {
    align-items: center;
    display: flex;
    grid-area: field;
    min-width: 0;
    position: relative;
  }

  .composer-keyboard-hint {
    display: none;
    font-size: var(--font-size-small);
    grid-area: hint;
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-row.formatting-open .composer-keyboard-hint {
    display: none;
  }

  @media (pointer: fine) {
    @container (width >= 32rem) {
      .composer-keyboard-hint {
        display: block;
      }
    }

    @container (width >= 44rem) {
      .composer-formatting :global(.formatting) {
        flex-wrap: wrap;
        height: auto;
        justify-content: end;
        overflow: visible;
      }
    }
  }

  :global(.composer-separator) {
    align-self: center;
    border-left: var(--border-width-500) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    height: var(--size-x400);
    margin-inline: var(--space-100);
  }

  .composer-before {
    align-self: end;
    grid-area: before;
  }

  .composer-after {
    grid-area: after;
    place-self: end;
  }

  .composer-file {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }

  :global(.composer-format) {
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
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

  :global(.composer-send),
  :global(.composer-voice) {
    border-radius: var(--radius);
    color: var(--primary-main);
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
  }

  :global(.composer-voice) {
    color: var(--surface-var-on-container);
  }

  :global(.composer-send)::after,
  :global(.composer-voice)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-send:disabled),
  :global(.composer-voice:disabled) {
    color: var(--sec-main);
  }

  :global(.composer-send:not(:disabled):hover),
  :global(.composer-send:not(:disabled):focus-visible),
  :global(.composer-voice:not(:disabled):hover),
  :global(.composer-voice:not(:disabled):focus-visible) {
    background: var(--surface-container-hover);
  }

  :global(.composer-send[data-pressing]) {
    background: var(--surface-container-hover);
  }

  :global(.composer-send svg),
  :global(.composer-voice svg) {
    display: block;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.composer-send svg) {
      transition: transform var(--motion-fast) var(--motion-easing-standard);
    }

    :global(.composer-send[data-pressing] svg) {
      transform: scale(1.3);
      transition: transform var(--press-ms) linear;
    }

    .composer {
      transition: border-color var(--motion-fast) var(--motion-easing-standard);
    }
  }

  .composer-field :global(.icon-button-small.composer-expand) {
    --button-height: var(--size-x500);
    --button-icon-size: var(--size-x50);

    color: var(--sec-main);
    inset-block-start: var(--space-050);
    inset-inline-end: var(--space-050);
    position: absolute;
  }

  .composer-field :global(.composer-expand)::after {
    content: '';
    inset: calc((var(--size-x500) - var(--target-hit)) / 2);
    position: absolute;
  }
</style>
