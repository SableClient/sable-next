<script lang="ts">
  import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
  import type {
    EditVersionView,
    ImageSourcePackView,
    MemberView,
    MessageKind,
    PerMessageProfileView,
    PersonaView,
  } from '#src/generated/protocol';

  import { formattedForEditing } from '#lib/composer/composer-context.js';
  import { editMessage } from '#lib/core/api/messages.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { projectPersona } from '#lib/personas/persona.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { outgoingPersona } from '#lib/personas/outgoing-persona.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import StealEmotesDialog from '#lib/features/emotes/StealEmotesDialog.svelte';
  import { emoteCandidates } from '#lib/features/emotes/steal-emotes.js';

  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import EditHistoryDialog from './EditHistoryDialog.svelte';
  import MessageActionSheet from './MessageActionSheet.svelte';
  import type { MessageDialogs, OpenMessageDialog } from './message-dialogs.svelte.js';
  import MessageForwardDialog from './MessageForwardDialog.svelte';
  import MessageReportDialog from './MessageReportDialog.svelte';
  import MessageReproxyDialog from './MessageReproxyDialog.svelte';
  import MessageSourceDialog from './MessageSourceDialog.svelte';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import ReactionSheet from './ReactionSheet.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReceiptsDialog from '../timeline/ReceiptsDialog.svelte';
  import { replyPreviewBody, type ReplyVersion } from './reply-preview';
  import { canRedact } from '../timeline/timeline-format';

  interface Props {
    dialogs: MessageDialogs;
    events: { get(eventId: string): ResolvedItem | null };
    roomId?: string;
    members?: readonly MemberView[];
    currentUserId?: string | null;
    readers?: (item: ResolvedItem) => readonly string[];
    receiptTimestamps?: (item: ResolvedItem) => Readonly<Record<string, number>>;
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onSenderProfile?: (
      userId: string,
      anchor: HTMLElement,
      pmp?: PerMessageProfileView | null
    ) => void;
    onToggleReaction?: (
      eventId: string,
      key: string,
      sourcePack?: ImageSourcePackView | null
    ) => void;
    onReply?: (eventId: string, version?: ReplyVersion) => void;
    onOpenThread?: (rootEventId: string) => void;
    onDelete?: (eventId: string, reason: string | null) => void;
  }

  let {
    dialogs,
    events,
    roomId = '',
    members = [],
    currentUserId = null,
    readers = (item) => item.read_by,
    receiptTimestamps = (item) => item.read_timestamps,
    canRedactOwn = true,
    canRedactOthers = false,
    onMatrixLink,
    onSenderProfile,
    onToggleReaction,
    onReply,
    onOpenThread,
    onDelete,
  }: Props = $props();

  const core = useCoreClient();
  const personaStore = usePersonaStore();
  const roomList = useRoomList();

  function live(entry: OpenMessageDialog): ResolvedItem {
    return (entry.item.event_id && events.get(entry.item.event_id)) || entry.item;
  }

  function preview(item: ResolvedItem): string | null {
    return item.content.kind === 'message' ? item.content.body : null;
  }

  function failed(action: string): (error: unknown) => void {
    return (error) => {
      console.warn(`[sable timeline] ${action} failed`, error);
      toasts.error(i18n.t('errors.actionFailed'));
    };
  }

  function report(item: ResolvedItem, reason: string | null): void {
    if (!item.event_id) return;
    void core.rpc.messages
      .report({ room_id: roomId, event_id: item.event_id, reason })
      .catch(failed('report'));
  }

  function forward(item: ResolvedItem, toRoomIds: string[], includeMetadata: boolean): void {
    const eventId = item.event_id;
    if (!eventId) return;
    for (const toRoomId of toRoomIds) {
      void core.rpc.messages
        .forward({
          room_id: roomId,
          event_id: eventId,
          to_room_id: toRoomId,
          include_metadata: includeMetadata,
          persona: $state.snapshot(
            outgoingPersona(
              personaStore,
              toRoomId,
              personaSpaces(roomList.rooms, toRoomId, undefined).order
            ).persona
          ),
        })
        .catch(failed('forward'));
    }
  }

  function reproxyKind(content: ResolvedItem['content']): MessageKind {
    if (content.kind !== 'message') return 'text';
    if (content.emote) return 'emote';
    return content.notice ? 'notice' : 'text';
  }

  function reproxy(item: ResolvedItem, persona: PersonaView | null): void {
    const content = item.content;
    if (!item.event_id) return;
    const media =
      content.kind === 'image' ||
      content.kind === 'video' ||
      content.kind === 'audio' ||
      content.kind === 'file';
    if (content.kind === 'gallery' || content.kind === 'location') {
      void core.rpc.messages
        .reprofile({
          room_id: roomId,
          event_id: item.event_id,
          thread_root: item.thread_root ?? null,
          persona: $state.snapshot(persona ? projectPersona(persona, false) : null),
        })
        .catch(failed('reproxy'));
      return;
    }
    if (content.kind !== 'message' && !media) return;
    const body = content.kind === 'message' ? content.body : (content.caption ?? '');
    void editMessage(core.rpc, roomId, item.event_id, body, {
      formatted: formattedForEditing(content.html),
      kind: reproxyKind(content),
      media_caption: media,
      thread_root: item.thread_root ?? null,
      persona: persona ? projectPersona(persona, preferences.personaFallback && body !== '') : null,
    }).catch(failed('reproxy'));
  }

  function replyToVersion(item: ResolvedItem, version: EditVersionView): void {
    if (!item.event_id || !onReply) return;
    const body = replyPreviewBody({
      kind: 'message',
      body: version.body,
      html: version.html,
      emote: false,
      notice: false,
      edited: false,
    });
    onReply(version.event_id, { of: item.event_id, body, html: version.html });
  }
</script>

{#each dialogs.stack as entry (entry.key)}
  {@const item = live(entry)}
  {@const setOpen = (open: boolean) => {
    if (!open) dialogs.close(entry.key);
  }}
  {#if entry.kind === 'source'}
    <MessageSourceDialog
      bind:open={() => true, setOpen}
      source={entry.source}
      encrypted={entry.encrypted}
      original={entry.original}
    />
  {:else if entry.kind === 'edit-history'}
    <EditHistoryDialog
      bind:open={() => true, setOpen}
      versions={entry.versions}
      senderTimezone={entry.senderTimezone}
      {onMatrixLink}
      onReply={onReply ? (version) => replyToVersion(item, version) : undefined}
      onThread={onOpenThread ? (version) => onOpenThread(version.event_id) : undefined}
      onDelete={onDelete && canRedact(item, canRedactOwn, canRedactOthers)
        ? (version) => dialogs.open(item, { kind: 'delete', target: version.event_id })
        : undefined}
    />
  {:else if entry.kind === 'report'}
    <MessageReportDialog
      bind:open={() => true, setOpen}
      onReport={(reason) => report(item, reason)}
    />
  {:else if entry.kind === 'steal'}
    <StealEmotesDialog bind:open={() => true, setOpen} candidates={emoteCandidates(item.content)} />
  {:else if entry.kind === 'forward'}
    <MessageForwardDialog
      bind:open={() => true, setOpen}
      fromRoomId={roomId}
      metadataLocked={item.forwarded != null}
      onForward={(toRoomIds, includeMetadata) => forward(item, toRoomIds, includeMetadata)}
    />
  {:else if entry.kind === 'reproxy'}
    <MessageReproxyDialog
      bind:open={() => true, setOpen}
      personas={personaStore.personas}
      current={item.per_message_profile}
      onChoose={(persona) => reproxy(item, persona)}
    />
  {:else if entry.kind === 'react'}
    <ReactionSheet
      bind:open={() => true, setOpen}
      {roomId}
      anchor={entry.anchor}
      onPick={(key, sourcePack) => {
        onToggleReaction?.(item.event_id ?? '', key, sourcePack);
      }}
    />
  {:else if entry.kind === 'sheet'}
    <MessageActionSheet
      bind:open={() => true, setOpen}
      preview={preview(item)}
      {...entry.actions()}
    />
  {:else if entry.kind === 'delete'}
    <DeleteMessageDialog
      bind:open={() => true, setOpen}
      preview={preview(item)}
      onConfirm={(reason) => onDelete?.(entry.target, reason)}
    />
  {:else if entry.kind === 'reactions'}
    <ReactionsDialog
      bind:open={() => true, setOpen}
      active={entry.active}
      reactions={item.reactions}
      eventId={item.event_id}
      {roomId}
      {members}
      {currentUserId}
      {canRedactOwn}
      {canRedactOthers}
      {onReply}
      onMemberProfile={onSenderProfile}
    />
  {:else if entry.kind === 'receipts'}
    <ReceiptsDialog
      bind:open={() => true, setOpen}
      readers={readers(item).filter((readerId) => readerId !== currentUserId)}
      timestamps={receiptTimestamps(item)}
      {members}
      onMemberProfile={onSenderProfile}
    />
  {/if}
{/each}
