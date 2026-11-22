import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { MemberView, PersonaView, Rpc, TimelineItemView } from '#src/generated/protocol';
import { formattedForEditing } from '#lib/composer/composer-context.js';
import { editMessage } from '#lib/core/api/messages.svelte.js';
import { personaSpaces } from '#lib/features/composer/persona-spaces.js';
import { outgoingPersona } from '#lib/personas/outgoing-persona.js';
import { projectPersona, senderDisplayName } from '#lib/personas/persona.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { Bookmarks } from '#lib/rooms/bookmarks.svelte.js';
import type { RoomList } from '#lib/rooms/room-list.svelte.js';

import { findMember } from '../members/members.js';
import { canRedact } from '../timeline/timeline-format.js';
import { isMediaCaptionContent } from './media-caption.js';

export function isSelectable(item: TimelineItemView): boolean {
  return (
    item.event_id !== null &&
    item.row !== 'annotation' &&
    item.send_state?.status !== 'sending' &&
    item.send_state?.status !== 'failed'
  );
}

export class MessageSelection {
  readonly #items = new SvelteMap<string, TimelineItemView>();
  #anchorId = $state<string | null>(null);

  constructor(private readonly ordered: () => readonly TimelineItemView[] = () => []) {}

  get active(): boolean {
    return this.#items.size > 0;
  }

  get count(): number {
    return this.#items.size;
  }

  get anchorId(): string | null {
    return this.#anchorId;
  }

  has(eventId: string | null | undefined): boolean {
    return eventId !== null && eventId !== undefined && this.#items.has(eventId);
  }

  enter(item: TimelineItemView): void {
    if (!isSelectable(item) || !item.event_id) return;
    this.#items.set(item.event_id, item);
    this.#anchorId = item.event_id;
  }

  toggle(item: TimelineItemView): void {
    if (!isSelectable(item) || !item.event_id) return;
    const eventId = item.event_id;
    if (this.#items.has(eventId)) {
      this.#items.delete(eventId);
      if (this.#items.size === 0 || this.#anchorId === eventId) {
        this.#anchorId = null;
      }
      return;
    }
    this.#items.set(eventId, item);
    this.#anchorId = eventId;
  }

  selectRange(target: TimelineItemView): void {
    if (!isSelectable(target) || !target.event_id) return;
    const targetId = target.event_id;
    const anchorId = this.#anchorId;
    if (!anchorId || anchorId === targetId) {
      this.toggle(target);
      return;
    }
    const candidates = this.ordered().filter(isSelectable);
    const anchorIndex = candidates.findIndex((entry) => entry.event_id === anchorId);
    const targetIndex = candidates.findIndex((entry) => entry.event_id === targetId);
    if (anchorIndex < 0 || targetIndex < 0) {
      this.toggle(target);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    for (let index = start; index <= end; index += 1) {
      const entry = candidates[index];
      if (entry.event_id) this.#items.set(entry.event_id, entry);
    }
    this.#anchorId = targetId;
  }

  selectAll(): void {
    for (const item of this.ordered()) {
      if (isSelectable(item) && item.event_id) {
        this.#items.set(item.event_id, item);
      }
    }
  }

  clear(): void {
    this.#items.clear();
    this.#anchorId = null;
  }

  keepOnly(eventIds: Iterable<string>): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup only, never rendered
    const keep = new Set(eventIds);
    for (const key of [...this.#items.keys()]) {
      if (!keep.has(key)) this.#items.delete(key);
    }
    if (this.#anchorId !== null && !this.#items.has(this.#anchorId)) {
      this.#anchorId = null;
    }
  }

  selected(liveLookup?: { get(eventId: string): TimelineItemView | null }): TimelineItemView[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local position lookup, never rendered
    const positions = new Map<string, number>();
    const ordered = this.ordered();
    for (let index = 0; index < ordered.length; index += 1) {
      const eventId = ordered[index].event_id;
      if (eventId && !positions.has(eventId)) positions.set(eventId, index);
    }
    const items = [...this.#items.entries()].map(
      ([eventId, snapshot]) => liveLookup?.get(eventId) ?? snapshot
    );
    items.sort((a, b) => {
      const posA = a.event_id ? positions.get(a.event_id) : undefined;
      const posB = b.event_id ? positions.get(b.event_id) : undefined;
      if (posA !== undefined && posB !== undefined) return posA - posB;
      return a.timestamp - b.timestamp || (posA !== undefined ? 1 : posB !== undefined ? -1 : 0);
    });
    return items;
  }
}

export const [useMessageSelection, provideMessageSelection, hasMessageSelection] =
  createContext<MessageSelection>();

export function messageCopyText(item: TimelineItemView): string | null {
  if (item.content.kind === 'message') {
    return item.content.body === '' ? null : item.content.body;
  }
  if (isMediaCaptionContent(item.content)) {
    const caption = item.content.caption ?? '';
    return caption === '' ? null : caption;
  }
  return null;
}

export function formatCopiedMessages(
  items: readonly TimelineItemView[],
  members: readonly MemberView[]
): string {
  const entries: { sender: string; body: string }[] = [];
  for (const item of items) {
    const body = messageCopyText(item);
    if (body === null) continue;
    const sender =
      item.per_message_profile?.display_name ??
      (item.sender ? findMember(members, item.sender)?.display_name : null) ??
      senderDisplayName(item) ??
      '';
    entries.push({ sender, body });
  }
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0].body;
  const separator = entries.some((entry) => entry.body.includes('\n')) ? '\n\n' : '\n';
  return entries
    .map((entry) => (entry.sender ? `${entry.sender}: ${entry.body}` : entry.body))
    .join(separator);
}

export async function forwardToRooms(
  rpc: Pick<Rpc, 'messages'>,
  personaStore: PersonaStore,
  roomList: RoomList,
  params: {
    roomId: string;
    eventId: string;
    toRoomIds: readonly string[];
    includeMetadata: boolean;
  }
): Promise<void> {
  let firstError: Error | null = null;
  for (const toRoomId of params.toRoomIds) {
    const persona = $state.snapshot(
      outgoingPersona(personaStore, toRoomId, personaSpaces(roomList, toRoomId, undefined).order)
        .persona
    );
    try {
      await rpc.messages.forward({
        room_id: params.roomId,
        event_id: params.eventId,
        to_room_id: toRoomId,
        include_metadata: params.includeMetadata,
        persona,
      });
    } catch (error: unknown) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (firstError !== null) throw firstError;
}

export async function reproxyEvent(
  rpc: Rpc,
  params: {
    roomId: string;
    item: TimelineItemView;
    persona: PersonaView | null;
    personaFallback: boolean;
  }
): Promise<void> {
  const { roomId, item, persona, personaFallback } = params;
  if (!item.event_id) return;
  const { content } = item;
  const media = isMediaCaptionContent(content);
  if (content.kind === 'gallery' || content.kind === 'location') {
    await rpc.messages.reprofile({
      room_id: roomId,
      event_id: item.event_id,
      thread_root: item.thread_root ?? null,
      persona: persona ? projectPersona(persona, false) : null,
    });
    return;
  }
  if (content.kind !== 'message' && !media) return;
  const body = content.kind === 'message' ? content.body : (content.caption ?? '');
  await editMessage(rpc, roomId, item.event_id, body, {
    formatted: formattedForEditing(content.html),
    kind: content.kind === 'message' ? content.msgtype : 'text',
    media_caption: media,
    thread_root: item.thread_root ?? null,
    persona: persona ? projectPersona(persona, personaFallback && body !== '') : null,
  });
}

export interface BatchCapabilities {
  copyable: TimelineItemView[];
  forwardable: TimelineItemView[];
  bookmarkable: TimelineItemView[];
  allBookmarked: boolean;
  reproxyable: TimelineItemView[];
  reportable: TimelineItemView[];
  deletable: TimelineItemView[];
}

function isReproxyableContent(content: TimelineItemView['content']): boolean {
  return (
    content.kind === 'message' ||
    content.kind === 'gallery' ||
    content.kind === 'location' ||
    isMediaCaptionContent(content)
  );
}

export function batchCapabilities(
  items: readonly TimelineItemView[],
  context: {
    roomId: string;
    canEdit: boolean;
    canDelete: boolean;
    canRedactOwn: boolean;
    canRedactOthers: boolean;
    bookmarks: Pick<Bookmarks, 'has'>;
  }
): BatchCapabilities {
  const copyable = items.filter((item) => messageCopyText(item) !== null);
  const inRoom = context.roomId !== '' ? items.filter((item) => item.event_id !== null) : [];
  return {
    copyable,
    forwardable: inRoom.filter((item) => item.forwardable),
    bookmarkable: inRoom,
    allBookmarked:
      inRoom.length > 0 &&
      inRoom.every((item) => context.bookmarks.has(context.roomId, item.event_id)),
    reproxyable: context.canEdit
      ? inRoom.filter((item) => item.is_own && isReproxyableContent(item.content))
      : [],
    reportable: inRoom.filter((item) => !item.is_own),
    deletable: context.canDelete
      ? inRoom.filter((item) => canRedact(item, context.canRedactOwn, context.canRedactOthers))
      : [],
  };
}

export interface BatchProgress {
  completed: number;
  total: number;
}

export interface BatchFailure<T> {
  item: T;
  error: unknown;
}

export interface BatchOutcome<T> {
  succeeded: T[];
  failed: BatchFailure<T>[];
  remaining: T[];
  cancelled: boolean;
}

export async function runBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: BatchProgress) => void;
  } = {}
): Promise<BatchOutcome<T>> {
  const succeeded: T[] = [];
  const failed: BatchFailure<T>[] = [];
  const total = items.length;

  for (let index = 0; index < total; index += 1) {
    if (options.signal?.aborted) {
      return { succeeded, failed, remaining: items.slice(index), cancelled: true };
    }
    const item = items[index];
    try {
      await run(item);
      succeeded.push(item);
    } catch (error: unknown) {
      failed.push({ item, error });
    }
    options.onProgress?.({ completed: index + 1, total });
  }

  return { succeeded, failed, remaining: [], cancelled: false };
}
