<script lang="ts">
  import type {
    EditVersionView,
    ImageSourcePackView,
    MemberView,
    MessageKind,
    PersonaView,
    TimelineItemView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { projectPersona } from '#lib/personas/persona.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
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
  import type { MatrixLink } from './matrix-link';
  import ReactionSheet from './ReactionSheet.svelte';
  import ReactionsDialog from './ReactionsDialog.svelte';
  import ReceiptsDialog from './ReceiptsDialog.svelte';
  import { replyPreviewBody, type ReplyVersion } from './reply-preview';
  import { canRedact } from './timeline-format';

  interface Props {
    dialogs: MessageDialogs;
    events: { get(eventId: string): TimelineItemView | null };
    roomId?: string;
    members?: readonly MemberView[];
    currentUserId?: string | null;
    readers?: (item: TimelineItemView) => readonly string[];
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
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

  function live(entry: OpenMessageDialog): TimelineItemView {
    return (entry.item.event_id && events.get(entry.item.event_id)) || entry.item;
  }

  function preview(item: TimelineItemView): string | null {
    return item.content.kind === 'message' ? item.content.body : null;
  }

  function failed(action: string): (error: unknown) => void {
    return (error) => {
      console.warn(`[sable timeline] ${action} failed`, error);
      toasts.error($i18n.t('errors.actionFailed'));
    };
  }

  function report(item: TimelineItemView, reason: string | null): void {
    if (!item.event_id) return;
    void core.commands.reportMessage(roomId, item.event_id, reason).catch(failed('report'));
  }

  function forward(item: TimelineItemView, toRoomIds: string[]): void {
    const eventId = item.event_id;
    if (!eventId) return;
    for (const toRoomId of toRoomIds) {
      void core.commands.forwardMessage(roomId, eventId, toRoomId).catch(failed('forward'));
    }
  }

  function reproxyKind(content: TimelineItemView['content']): MessageKind {
    if (content.kind !== 'message') return 'text';
    if (content.emote) return 'emote';
    return content.notice ? 'notice' : 'text';
  }

  function reproxy(item: TimelineItemView, persona: PersonaView | null): void {
    if (!item.event_id || item.content.kind !== 'message') return;
    void core.commands
      .editMessage(roomId, item.event_id, item.content.body, {
        formatted: item.content.html,
        kind: reproxyKind(item.content),
        threadRoot: item.thread_root ?? null,
        persona: persona ? projectPersona(persona, preferences.personaFallback) : null,
      })
      .catch(failed('reproxy'));
  }

  function replyToVersion(item: TimelineItemView, version: EditVersionView): void {
    if (!item.event_id || !onReply) return;
    const body = replyPreviewBody({
      kind: 'message',
      body: version.body,
      html: version.html,
      emote: false,
      notice: false,
      edited: false,
    });
    onReply(version.event_id, { of: item.event_id, body });
  }
</script>

{#each dialogs.stack as entry (entry.key)}
  {@const item = live(entry)}
  {@const setOpen = (open: boolean) => {
    if (!open) dialogs.close(entry.key);
  }}
  {#if entry.kind === 'source'}
    <MessageSourceDialog bind:open={() => true, setOpen} source={entry.source} />
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
      onForward={(toRoomIds) => forward(item, toRoomIds)}
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
      {roomId}
      {members}
      onMemberProfile={onSenderProfile}
    />
  {:else if entry.kind === 'receipts'}
    <ReceiptsDialog
      bind:open={() => true, setOpen}
      readers={readers(item).filter((readerId) => readerId !== currentUserId)}
      {members}
      onMemberProfile={onSenderProfile}
    />
  {/if}
{/each}
