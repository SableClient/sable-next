import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import type {
  PackImageInfoView,
  ImageSourcePackView,
  ImageSourcePackReferenceView,
  MessageKind,
  PerMessageProfileView,
  PersonaView,
  UrlPreviewView,
} from '#src/generated/protocol';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { runtimeConfig } from '#lib/config/runtime-config.js';
import { t } from '#lib/i18n.js';
import type { CoreClient, OutgoingMentions } from '#lib/core/client.svelte.js';
import type { SendAttachmentOptions, SendGalleryOptions } from '#lib/core/media.svelte.js';
import { editMessage, sendMessage } from '#lib/core/api/messages.svelte.js';
import type { BotCommandInvocation } from '#lib/features/composer/bot-commands.js';
import { readReply, writeReply } from '#lib/composer/composer-drafts.svelte.js';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import {
  formattedForEditing,
  type ComposerContext,
  type ScheduledTarget,
} from '#lib/composer/composer-context.js';
import { dequeue, enqueue } from '#lib/composer/scheduled-queue.svelte.js';
import {
  isEncryptedScheduleUnsupported,
  isServerScheduleUnsupported,
  ScheduledOriginalKept,
} from '#lib/features/composer/send-failure.js';
import {
  applySed,
  applySedToHtml,
  parseSed,
  type SedEdit,
} from '#lib/features/composer/sed-edit.js';
import { runSlash, SlashError } from '#lib/features/composer/slash-commands.js';
import { knockPagePath } from '#lib/rooms/join-or-knock.js';
import { gifFilename, proxiedGif, type GifResult } from '#lib/gif/providers.js';
import { replyPreviewBody, type ReplyVersion } from '#lib/features/room/messages/reply-preview.js';
import { isMediaCaptionContent } from '#lib/features/room/messages/media-caption.js';
import { previewableLinks } from '#lib/features/room/media/link-preview.js';
import { previewSources, resolveUrlPreview } from '#lib/features/room/media/link-preview-cache.js';
import { projectPersona } from '#lib/personas/persona.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import { outgoingPersona } from '#lib/personas/outgoing-persona.js';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { stateEventText } from '#lib/features/room/timeline/state-event-text.js';
import { isMessageRow } from '#lib/features/room/timeline/timeline-format.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const NO_MENTIONS: OutgoingMentions = { user_ids: [], room: false };

export type ConversationSendResult = { kind: 'gifSearch'; query: string };

export type ConversationDeps = {
  core: CoreClient;
  personas: PersonaStore;
  timeline: RoomTimeline;
  roomId: () => string;
  spaceIds?: (roomId: string) => readonly string[];
  encrypted?: () => boolean | null;
  beforeSend?: () => Promise<void>;
  threadRoot?: string | null;
};

function failed(action: string): (error: unknown) => void {
  return (error) => {
    console.warn(`[sable room] ${action} failed`, error);
  };
}

export class Conversation {
  #context = $state<ComposerContext | null>(null);
  readonly restored: ComposerContext | null;
  scheduledRevision = $state(0);
  forumTitle = $state('');
  dismissedPreviews = $state.raw<string[]>([]);

  readonly #core: CoreClient;
  readonly #personas: PersonaStore;
  readonly #timeline: RoomTimeline;
  readonly #roomId: () => string;
  readonly #spaceIds: (roomId: string) => readonly string[];
  readonly #encrypted: () => boolean | null;
  readonly #threadRoot: string | null;
  readonly #beforeSend: () => Promise<void>;

  constructor({
    core,
    personas,
    timeline,
    roomId,
    spaceIds = () => [],
    encrypted,
    beforeSend = () => Promise.resolve(),
    threadRoot = null,
  }: ConversationDeps) {
    this.#core = core;
    this.#personas = personas;
    this.#timeline = timeline;
    this.#roomId = roomId;
    this.#spaceIds = spaceIds;
    this.#encrypted = encrypted ?? (() => null);
    this.#threadRoot = threadRoot;
    this.#beforeSend = beforeSend;
    this.restored = readReply(this.#replyKey(), this.#accountId()) ?? null;
    this.#context = this.restored;
  }

  get context(): ComposerContext | null {
    return this.#context;
  }

  followRoom(): void {
    this.#context = readReply(this.#replyKey(), this.#accountId()) ?? null;
    this.forumTitle = '';
    this.dismissedPreviews = [];
  }

  set context(value: ComposerContext | null) {
    this.#context = value;
    writeReply(this.#replyKey(), value?.kind === 'reply' ? value : null, this.#accountId());
  }

  #replyKey(): string {
    return this.#threadRoot === null ? this.#roomId() : `${this.#roomId()}/${this.#threadRoot}`;
  }

  #accountId(): string {
    return this.#core.session?.account_id ?? '';
  }

  get threadRoot(): string | null {
    return this.#threadRoot;
  }

  async #bundledLinkPreviews(
    html: string | null,
    body: string,
    dismissed: readonly string[]
  ): Promise<{ previews: UrlPreviewView[]; suppressed: boolean }> {
    const sources = previewSources(this.#encrypted());
    if (!sources.server && !sources.client) return { previews: [], suppressed: false };
    if (!html) return { previews: [], suppressed: false };
    const links = previewableLinks(html, body);
    const wanted = links.filter((url) => !dismissed.includes(url));
    const previews = await Promise.all(
      wanted.map((url) => resolveUrlPreview(this.#core.rpc.messages, url, sources))
    );
    return {
      previews: previews.filter((preview) => preview !== null),
      suppressed: links.length > 0 && wanted.length === 0,
    };
  }

  readonly dismissPreview = (url: string): void => {
    if (!this.dismissedPreviews.includes(url))
      this.dismissedPreviews = [...this.dismissedPreviews, url];
  };

  readonly sendMessage = async (
    targetRoomId: string,
    body: string,
    formatted: string | null = null,
    mentions: OutgoingMentions = NO_MENTIONS,
    imageSourcePacks: ImageSourcePackReferenceView[] = []
  ): Promise<ConversationSendResult | undefined> => {
    const pending = this.context;
    if (body === '' && !(pending?.kind === 'edit' && pending.mediaCaption)) return;

    if (pending?.kind === 'edit') {
      const edited = this.#timeline.items.find(
        (entry) =>
          entry.id === pending.timelineItemId ||
          entry.event_id === pending.eventId ||
          entry.transaction_id === pending.eventId
      );
      const unchanged =
        body === pending.body &&
        (formatted === null || formatted === pending.html) &&
        (pending.persona ?? null) === (edited?.per_message_profile ?? null) &&
        this.forumTitle === (edited?.forum_title ?? '');
      if (unchanged) {
        this.context = null;
        return;
      }
      await this.#beforeSend();
      await editMessage(
        this.#core.rpc,
        targetRoomId,
        edited?.event_id ?? (pending.eventId.startsWith('$') ? pending.eventId : null),
        body,
        {
          transaction_id: edited?.event_id ? null : edited?.transaction_id,
          formatted,
          mentions,
          kind: editedKind(edited),
          media_caption: pending.mediaCaption,
          thread_root: this.#threadRoot,
          persona: pending.persona ?? null,
          forum_title: this.forumTitle,
        }
      );
      this.forumTitle = '';
      this.context = null;
      return;
    }

    const sed = preferences.sedEdits ? parseSed(body) : null;
    if (sed) {
      await this.#sedEdit(targetRoomId, sed);
      this.context = null;
      return;
    }

    await this.#beforeSend();
    const outcome = await runSlash(body, {
      roomId: targetRoomId,
      userId: this.#core.session?.user_id ?? null,
      formatted,
      developerTools: preferences.developerTools,
      rpc: this.#core.rpc,
      persona: () => this.#personaFor(targetRoomId, '', null).persona,
    });
    if (outcome.kind === 'done') {
      this.context = null;
      return;
    }
    if (outcome.kind === 'gifSearch') {
      this.context = null;
      return outcome;
    }
    if (outcome.kind === 'bugReport') {
      this.context = null;
      void goto(resolve('bugreport'));
      return;
    }
    if (outcome.kind === 'knock') {
      this.context = null;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- knockPagePath() resolves the route itself
      void goto(knockPagePath(outcome.address, outcome.via));
      return;
    }

    const untouched = outcome.body === body;
    const outgoing = this.#personaFor(
      targetRoomId,
      outcome.body,
      untouched ? (outcome.formatted ?? formatted) : (outcome.formatted ?? null)
    );
    if (outgoing.body === '') return;
    const dismissed = this.dismissedPreviews;
    this.dismissedPreviews = [];
    const { previews: linkPreviews, suppressed } = await this.#bundledLinkPreviews(
      outgoing.formatted,
      outgoing.body,
      dismissed
    );
    await sendMessage(this.#core.rpc, targetRoomId, outgoing.body, {
      in_reply_to: pending?.eventId ?? null,
      thread_root: this.#threadRoot,
      formatted: outgoing.formatted,
      mentions: untouched || outcome.verbatim === true ? mentions : NO_MENTIONS,
      silent_reply: pending?.silentReply ?? false,
      kind: outcome.msgtype,
      persona: outgoing.persona,
      link_previews: linkPreviews,
      no_link_previews: suppressed,
      image_source_packs: imageSourcePacks,
      forum_title: this.#threadRoot === null && !pending?.eventId ? this.forumTitle : null,
    });
    this.forumTitle = '';
    this.context = null;
  };

  readonly sendBotCommand = async (
    targetRoomId: string,
    bot: string,
    body: string,
    invocation: BotCommandInvocation
  ): Promise<void> => {
    const pending = this.context?.kind === 'reply' ? this.context : null;
    await this.#beforeSend();
    const profile = this.#personaFor(targetRoomId, '', null).persona;
    await sendMessage(this.#core.rpc, targetRoomId, body, {
      in_reply_to: pending?.eventId ?? null,
      thread_root: this.#threadRoot,
      mentions: { user_ids: [bot], room: false },
      silent_reply: pending?.silentReply ?? false,
      bot_command: invocation,
      persona: profile ? { ...profile, has_fallback: false } : null,
    });
    if (pending) this.context = null;
  };

  readonly sendAttachment = async (
    targetRoomId: string,
    file: File,
    options: SendAttachmentOptions = {}
  ): Promise<void> => {
    await this.#beforeSend();
    const outgoing = this.#personaFor(
      targetRoomId,
      options.caption ?? '',
      options.formattedCaption ?? null
    );
    const reply = this.#consumeReply();
    await this.#core.media.sendAttachment(targetRoomId, file, {
      ...options,
      caption: options.caption == null ? options.caption : outgoing.body,
      formattedCaption: outgoing.formatted,
      inReplyTo: reply?.eventId ?? null,
      silentReply: reply?.silentReply ?? options.silentReply ?? false,
      threadRoot: this.#threadRoot,
      persona: outgoing.persona,
    });
  };

  readonly sendGallery = async (
    targetRoomId: string,
    files: readonly File[],
    options: SendGalleryOptions = {}
  ): Promise<void> => {
    await this.#beforeSend();
    const outgoing = this.#personaFor(
      targetRoomId,
      options.caption ?? '',
      options.formattedCaption ?? null
    );
    const reply = this.#consumeReply();
    await this.#core.media.sendGallery(targetRoomId, files, {
      ...options,
      caption: options.caption == null ? options.caption : outgoing.body,
      formattedCaption: outgoing.formatted,
      persona: outgoing.persona,
      inReplyTo: reply?.eventId ?? null,
      silentReply: reply?.silentReply ?? options.silentReply ?? false,
      threadRoot: this.#threadRoot,
    });
  };

  readonly sendSticker = async (
    targetRoomId: string,
    url: string,
    body: string,
    info: PackImageInfoView | null = null,
    sourcePack: ImageSourcePackView | null = null
  ): Promise<void> => {
    await this.#beforeSend();
    await this.#core.rpc.messages.sendSticker({
      room_id: targetRoomId,
      url,
      body,
      info,
      source_pack: $state.snapshot(sourcePack),
      in_reply_to: this.#consumeReply()?.eventId ?? null,
      thread_root: this.#threadRoot,
      persona: $state.snapshot(this.#personaFor(targetRoomId, '', null).persona),
    });
  };

  readonly sendGif = async (targetRoomId: string, gif: GifResult): Promise<void> => {
    await this.#beforeSend();
    const { gifs } = await runtimeConfig();
    const proxied = proxiedGif(gif, gifs.proxyUrl);
    if (!proxied) throw new Error('no GIF proxy route for this result');

    const reply = this.#consumeReply();
    await this.#core.rpc.messages.sendGif({
      room_id: targetRoomId,
      url: proxied.mxcUrl,
      body: gifFilename(gif.title, proxied.mimetype),
      width: gif.width || null,
      height: gif.height || null,
      mimetype: proxied.mimetype,
      size: gif.size > 0 ? gif.size : null,
      in_reply_to: reply?.eventId ?? null,
      silent_reply: reply?.silentReply ?? false,
      thread_root: this.#threadRoot,
      persona: $state.snapshot(this.#personaFor(targetRoomId, '', null).persona),
    });
  };

  readonly createPoll = async (
    targetRoomId: string,
    question: string,
    answers: string[],
    undisclosed: boolean,
    maxSelections: number = 1
  ): Promise<void> => {
    await this.#beforeSend();
    await this.#core.rpc.messages.createPoll({
      room_id: targetRoomId,
      persona: $state.snapshot(this.#personaFor(targetRoomId, '', null).persona),
      question,
      answers: [...answers],
      undisclosed,
      max_selections: maxSelections,
      thread_root: this.#threadRoot,
    });
  };

  readonly sendLocation = async (
    targetRoomId: string,
    body: string,
    geoUri: string
  ): Promise<void> => {
    await this.#beforeSend();
    const reply = this.#consumeReply();
    await this.#core.rpc.messages.sendLocation({
      room_id: targetRoomId,
      persona: $state.snapshot(this.#personaFor(targetRoomId, '', null).persona),
      body,
      geo_uri: geoUri,
      in_reply_to: reply?.eventId ?? null,
      silent_reply: reply?.silentReply ?? false,
      thread_root: this.#threadRoot,
    });
  };

  readonly schedule = async (
    targetRoomId: string,
    body: string,
    formatted: string | null,
    dueTs: number
  ): Promise<void> => {
    const delayMs = dueTs - Date.now();
    if (delayMs <= 0) return;

    const accountId = this.#core.session?.account_id ?? '';
    const replacing = this.context?.kind === 'schedule' ? this.context : null;
    await this.#scheduleNew(targetRoomId, body, formatted, dueTs, delayMs);
    if (replacing === null) {
      this.scheduledRevision += 1;
      return;
    }

    this.context = null;
    try {
      if (replacing.scheduled?.source === 'queue') dequeue(replacing.eventId, accountId);
      else await this.#core.rpc.messages.cancelScheduled({ delay_id: replacing.eventId });
    } catch (error) {
      throw new ScheduledOriginalKept(error);
    } finally {
      this.scheduledRevision += 1;
    }
  };

  async #scheduleNew(
    targetRoomId: string,
    body: string,
    formatted: string | null,
    dueTs: number,
    delayMs: number
  ): Promise<void> {
    const accountId = this.#core.session?.account_id ?? '';
    const deviceId = this.#core.session?.device_id ?? '';
    const outgoing = this.#personaFor(targetRoomId, body, formatted);
    try {
      await this.#core.rpc.messages.schedule({
        room_id: targetRoomId,
        body: outgoing.body,
        formatted: outgoing.formatted,
        persona: $state.snapshot(outgoing.persona),
        delay_ms: delayMs,
      });
      return;
    } catch (error) {
      if (!isServerScheduleUnsupported(error)) throw error;
      if (isEncryptedScheduleUnsupported(error) && !preferences.scheduleInEncryptedRooms) {
        throw error;
      }
    }

    enqueue(
      {
        id: crypto.randomUUID(),
        roomId: targetRoomId,
        body: outgoing.body,
        formatted: outgoing.formatted,
        persona: $state.snapshot(outgoing.persona),
        dueTs,
        owner: deviceId,
      },
      accountId
    );
  }

  readonly editScheduled = (
    id: string,
    body: string,
    html: string | null,
    scheduled: ScheduledTarget
  ): void => {
    this.context = { kind: 'schedule', eventId: id, body, html, scheduled };
  };

  readonly setTyping = async (targetRoomId: string, typing: boolean): Promise<void> => {
    if (!preferences.sendTypingNotifications) return;
    await this.#core.rpc.messages.setTyping({ room_id: targetRoomId, typing });
  };

  readonly retrySend = (transactionId: string): void => {
    void this.#core.rpc.messages
      .retrySend({
        room_id: this.#roomId(),
        transaction_id: transactionId,
        thread_root: this.#threadRoot,
      })
      .catch(failed('retry'));
  };

  readonly cancelSend = (transactionId: string): void => {
    void this.#core.rpc.messages
      .cancelSend({
        room_id: this.#roomId(),
        transaction_id: transactionId,
        thread_root: this.#threadRoot,
      })
      .catch(failed('cancel'));
  };

  readonly toggleReaction = (
    eventId: string,
    key: string,
    sourcePack: ImageSourcePackView | null = null
  ): void => {
    void this.#toggleReaction(eventId, key, sourcePack).catch(failed('reaction'));
  };

  readonly quickReact = async (
    targetRoomId: string,
    key: string,
    sourcePack: ImageSourcePackView | null = null
  ): Promise<void> => {
    await this.#beforeSend();
    if (targetRoomId !== this.#roomId()) throw new Error('Room changed while reacting');
    const items = this.#timeline.items;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item.event_id || !isMessageRow(item) || item.content.kind === 'redacted') continue;
      await this.#toggleReaction(item.event_id, key, sourcePack);
      return;
    }
  };

  async #toggleReaction(
    eventId: string,
    key: string,
    sourcePack: ImageSourcePackView | null
  ): Promise<void> {
    const mine = this.#timeline.items
      .find((item) => item.event_id === eventId)
      ?.reactions.some(
        (reaction) =>
          reaction.key === key && reaction.senders.includes(this.#core.session?.user_id ?? '')
      );
    await this.#core.rpc.messages.react({
      room_id: this.#roomId(),
      event_id: eventId,
      key,
      source_pack: $state.snapshot(mine ? null : sourcePack),
      shortcode: null,
      thread_root: this.#threadRoot,
      subscription: this.#timeline.subscriptionId,
      persona: $state.snapshot(this.#personaFor(this.#roomId(), '', null).persona),
    });
  }

  readonly votePoll = (eventId: string, answers: string[]): void => {
    void this.#core.rpc.messages
      .votePoll({
        room_id: this.#roomId(),
        event_id: eventId,
        answers: [...answers],
        persona: $state.snapshot(this.#personaFor(this.#roomId(), '', null).persona),
        thread_root: this.#threadRoot,
      })
      .catch(failed('vote'));
  };

  readonly endPoll = (eventId: string): void => {
    void this.#core.rpc.messages
      .endPoll({
        room_id: this.#roomId(),
        event_id: eventId,
        thread_root: this.#threadRoot,
        persona: $state.snapshot(this.#personaFor(this.#roomId(), '', null).persona),
      })
      .catch(failed('end poll'));
  };

  readonly redact = (eventId: string, reason: string | null): void => {
    void this.#core.rpc.messages
      .redact({
        room_id: this.#roomId(),
        event_id: eventId,
        reason,
        thread_root: this.#threadRoot,
      })
      .catch(failed('redaction'));
  };

  readonly reply = (eventId: string, version?: ReplyVersion): void => {
    const target = version?.of ?? eventId;
    const item =
      this.#timeline.items.find((entry) => entry.event_id === target) ??
      this.#timeline.aggregations.find((entry) => entry.event_id === target);
    if (!item) return;

    this.context = {
      kind: 'reply',
      eventId,
      sender: item.per_message_profile?.display_name ?? item.sender_name ?? item.sender,
      silentReply: item.sender === this.#core.session?.user_id || !preferences.mentionInReplies,
      body: version?.body ?? (replyPreviewBody(item.content) || stateEventText(item, t)),
      html: version?.html ?? (item.content.kind === 'message' ? item.content.html : null),
    };
  };

  readonly moveReply = (eventId: string | null): void => {
    if (eventId === null) this.context = null;
    else if (this.context?.kind !== 'reply' || this.context.eventId !== eventId)
      this.reply(eventId);
  };

  readonly setEditPersona = (persona: PersonaView | null): void => {
    const pending = this.context;
    if (pending?.kind !== 'edit') return;
    this.context = {
      ...pending,
      persona: persona ? projectPersona(persona, preferences.personaFallback) : null,
    };
  };

  readonly toggleSilentReply = (): void => {
    const pending = this.context;
    if (pending?.kind !== 'reply') return;
    this.context = { ...pending, silentReply: pending.silentReply !== true };
  };

  readonly edit = (
    eventId: string,
    body: string,
    html: string | null = null,
    mediaCaption = false
  ): void => {
    const item = this.#timeline.items.find(
      (entry) => entry.event_id === eventId || entry.transaction_id === eventId
    );
    this.forumTitle = item?.forum_title ?? '';
    this.context = {
      kind: 'edit',
      eventId,
      timelineItemId: item?.id,
      body,
      html,
      mediaCaption,
      persona: item?.per_message_profile ?? null,
    };
  };

  #editTimelineItem(item: ResolvedItem, itemId: string): boolean {
    if (item.content.kind === 'message') {
      this.edit(itemId, item.content.body, item.content.html);
      return true;
    }
    if (isMediaCaptionContent(item.content)) {
      this.edit(itemId, item.content.caption ?? '', item.content.html, true);
      return true;
    }
    return false;
  }

  async #sedEdit(targetRoomId: string, sed: SedEdit): Promise<void> {
    const userId = this.#core.session?.user_id;
    const items = this.#timeline.items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const itemId = item.event_id ?? item.transaction_id;
      if (!itemId || item.sender !== userId || item.content.kind !== 'message') continue;

      const formatted = formattedForEditing(item.content.html);
      const rich = formatted === null ? null : applySedToHtml(formatted, sed);
      const body = rich?.body ?? applySed(item.content.body, sed);
      if (body === null) break;
      await this.#beforeSend();
      await editMessage(this.#core.rpc, targetRoomId, item.event_id, body, {
        transaction_id: item.event_id ? null : item.transaction_id,
        formatted: rich?.formatted ?? null,
        mentions: rich?.mentions,
        kind: editedKind(item),
        thread_root: this.#threadRoot,
        persona: item.per_message_profile ?? null,
        forum_title: item.forum_title ?? '',
      });
      return;
    }
    throw new SlashError('composer.sedNoMatch');
  }

  readonly editLast = (before?: string): void => {
    const userId = this.#core.session?.user_id;
    if (!userId) return;

    const items = this.#timeline.items;
    const end =
      before === undefined
        ? items.length
        : items.findIndex((entry) => entry.event_id === before || entry.transaction_id === before);
    for (let index = end - 1; index >= 0; index -= 1) {
      const item = items[index];
      const itemId = item.event_id ?? item.transaction_id;
      if (!itemId || item.sender !== userId) continue;
      if (this.#editTimelineItem(item, itemId)) return;
    }
  };

  readonly editNext = (after: string): void => {
    const userId = this.#core.session?.user_id;
    if (!userId) return;

    const items = this.#timeline.items;
    const start = items.findIndex(
      (entry) => entry.event_id === after || entry.transaction_id === after
    );
    if (start < 0) return;
    for (let index = start + 1; index < items.length; index += 1) {
      const item = items[index];
      const itemId = item.event_id ?? item.transaction_id;
      if (!itemId || item.sender !== userId) continue;
      if (this.#editTimelineItem(item, itemId)) return;
    }
    this.context = null;
  };

  readonly clearContext = (): void => {
    this.context = null;
  };

  /** Whether the message being edited is edited where it appears, not in the composer. */
  get inlineEdit(): boolean {
    const pending = this.context;
    if (!preferences.inlineEditing || pending?.kind !== 'edit' || pending.mediaCaption) {
      return false;
    }
    return this.#timeline.items.some(
      (entry) =>
        (entry.id === pending.timelineItemId ||
          entry.event_id === pending.eventId ||
          entry.transaction_id === pending.eventId) &&
        entry.content.kind === 'message'
    );
  }

  #inlineDraft: { eventId: string; doc: ProseMirrorNode } | null = null;

  /** Keeps the text typed in an inline editor whose row scrolled out of the list. */
  readonly stashInlineDraft = (eventId: string, doc: ProseMirrorNode): void => {
    this.#inlineDraft = { eventId, doc };
  };

  readonly takeInlineDraft = (eventId: string): ProseMirrorNode | undefined => {
    const draft = this.#inlineDraft;
    this.#inlineDraft = null;
    return draft?.eventId === eventId ? draft.doc : undefined;
  };

  #consumeReply(): ComposerContext | null {
    const reply = this.context?.kind === 'reply' ? this.context : null;
    if (reply !== null) this.context = null;
    return reply;
  }

  #personaFor(
    targetRoomId: string,
    body: string,
    formatted: string | null
  ): { body: string; formatted: string | null; persona: PerMessageProfileView | null } {
    return outgoingPersona(
      this.#personas,
      targetRoomId,
      this.#spaceIds(targetRoomId),
      body,
      formatted
    );
  }
}

function editedKind(edited: ResolvedItem | undefined): MessageKind {
  const content = edited?.content;
  if (content?.kind !== 'message') return 'text';
  if (content.emote) return 'emote';
  return content.notice ? 'notice' : 'text';
}
