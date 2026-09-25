import type {
  PackImageInfoView,
  ImageSourcePackView,
  ImageSourcePackReferenceView,
  MessageKind,
  PerMessageProfileView,
  TimelineItemView,
  UrlPreviewView,
} from '#src/generated/protocol';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { runtimeConfig } from '#lib/config/runtime-config.js';
import { t } from '#lib/i18n.js';
import type { CoreClient, OutgoingMentions } from '#lib/core/client.svelte.js';
import type { SendAttachmentOptions, SendGalleryOptions } from '#lib/core/commands.svelte.js';
import type { ComposerContext, ScheduledTarget } from '#lib/features/composer/composer-context.js';
import { dequeue, enqueue } from '#lib/features/composer/scheduled-queue.svelte.js';
import {
  isEncryptedScheduleUnsupported,
  isServerScheduleUnsupported,
  ScheduledOriginalKept,
} from '#lib/features/composer/send-failure.js';
import { runSlash } from '#lib/features/composer/slash-commands.js';
import { gifFilename, proxiedGif, type GifResult } from '#lib/features/gif/providers.js';
import { replyFallbackFromSource } from '#lib/features/room/reply-fallback.js';
import { replyPreviewBody } from '#lib/features/room/reply-preview.js';
import { firstPreviewableLink } from '#lib/features/room/link-preview.js';
import { loadUrlPreview } from '#lib/features/room/link-preview-cache.js';
import {
  projectPersona,
  resolvePersona,
  resolveProxy,
  stripProxyHtml,
} from '#lib/personas/persona.js';
import type { PersonaStore } from '#lib/personas/personas.svelte.js';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const NO_MENTIONS: OutgoingMentions = { userIds: [], room: false };

export type ConversationSendResult = { kind: 'gifSearch'; query: string };

export type ConversationDeps = {
  core: CoreClient;
  personas: PersonaStore;
  timeline: RoomTimeline;
  roomId: () => string;
  encrypted?: () => boolean | null;
  threadRoot?: string | null;
};

export class Conversation {
  context = $state<ComposerContext | null>(null);
  scheduledRevision = $state(0);

  readonly #core: CoreClient;
  readonly #personas: PersonaStore;
  readonly #timeline: RoomTimeline;
  readonly #roomId: () => string;
  readonly #encrypted: () => boolean | null;
  readonly #threadRoot: string | null;
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  readonly #requestedDetails = new Set<string>();

  constructor({
    core,
    personas,
    timeline,
    roomId,
    encrypted,
    threadRoot = null,
  }: ConversationDeps) {
    this.#core = core;
    this.#personas = personas;
    this.#timeline = timeline;
    this.#roomId = roomId;
    this.#encrypted = encrypted ?? (() => null);
    this.#threadRoot = threadRoot;
  }

  get threadRoot(): string | null {
    return this.#threadRoot;
  }

  async #bundledLinkPreviews(html: string | null): Promise<UrlPreviewView[]> {
    const enabled =
      this.#encrypted() === false ? preferences.urlPreviews : preferences.encryptedUrlPreviews;
    if (!enabled) return [];
    const url = html ? firstPreviewableLink(html) : null;
    if (!url) return [];
    const preview = await loadUrlPreview(this.#core.commands, url);
    return preview ? [preview] : [];
  }

  readonly sendMessage = async (
    targetRoomId: string,
    body: string,
    formatted: string | null = null,
    mentions: OutgoingMentions = NO_MENTIONS,
    imageSourcePacks: ImageSourcePackReferenceView[] = []
  ): Promise<ConversationSendResult | undefined> => {
    const pending = this.context;
    if (body === '') return;

    if (pending?.kind === 'edit') {
      const edited = this.#timeline.items.find(
        (entry) =>
          entry.id === pending.timelineItemId ||
          entry.event_id === pending.eventId ||
          entry.transaction_id === pending.eventId
      );
      await this.#core.commands.editMessage(
        targetRoomId,
        edited?.event_id ?? (pending.eventId.startsWith('$') ? pending.eventId : null),
        body,
        {
          transactionId: edited?.event_id ? null : edited?.transaction_id,
          formatted,
          mentions,
          kind: editedKind(edited),
          mediaCaption: pending.mediaCaption,
          threadRoot: this.#threadRoot,
          persona: edited?.per_message_profile ?? null,
        }
      );
      this.context = null;
      return;
    }

    const outcome = await runSlash(body, {
      roomId: targetRoomId,
      userId: this.#core.session?.user_id ?? null,
      formatted,
      developerTools: preferences.developerTools,
      commands: this.#core.commands,
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

    const untouched = outcome.body === body;
    const outgoing = this.#personaFor(
      targetRoomId,
      outcome.body,
      untouched ? (outcome.formatted ?? formatted) : (outcome.formatted ?? null)
    );
    const linkPreviews = await this.#bundledLinkPreviews(outgoing.formatted);
    await this.#core.commands.sendMessage(targetRoomId, outgoing.body, {
      inReplyTo: pending?.eventId ?? null,
      threadRoot: this.#threadRoot,
      formatted: outgoing.formatted,
      mentions: untouched || outcome.verbatim === true ? mentions : NO_MENTIONS,
      silentReply: pending?.silentReply ?? false,
      kind: outcome.msgtype,
      persona: outgoing.persona,
      linkPreviews,
      imageSourcePacks,
    });
    this.context = null;
  };

  readonly sendAttachment = async (
    targetRoomId: string,
    file: File,
    options: SendAttachmentOptions = {}
  ): Promise<void> => {
    const persona = this.#personaFor(targetRoomId, '', null).persona;
    await this.#core.commands.sendAttachment(targetRoomId, file, {
      ...options,
      inReplyTo: this.#consumeReply(),
      threadRoot: this.#threadRoot,
      persona,
    });
  };

  readonly sendGallery = async (
    targetRoomId: string,
    files: readonly File[],
    options: SendGalleryOptions = {}
  ): Promise<void> => {
    await this.#core.commands.sendGallery(targetRoomId, files, {
      ...options,
      inReplyTo: this.#consumeReply(),
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
    await this.#core.commands.sendSticker(
      targetRoomId,
      url,
      body,
      info,
      sourcePack,
      this.#consumeReply(),
      this.#threadRoot,
      this.#personaFor(targetRoomId, '', null).persona
    );
  };

  readonly sendGif = async (targetRoomId: string, gif: GifResult): Promise<void> => {
    const { gifs } = await runtimeConfig();
    const proxied = proxiedGif(gif, gifs.proxyUrl);
    if (!proxied) throw new Error('no GIF proxy route for this result');

    await this.#core.commands.sendGif(
      targetRoomId,
      proxied.mxcUrl,
      gifFilename(gif.title, proxied.mimetype),
      gif.width || null,
      gif.height || null,
      proxied.mimetype,
      gif.size > 0 ? gif.size : null,
      this.#consumeReply(),
      this.#threadRoot,
      this.#personaFor(targetRoomId, '', null).persona
    );
  };

  readonly createPoll = async (
    targetRoomId: string,
    question: string,
    answers: string[],
    undisclosed: boolean,
    maxSelections: number = 1
  ): Promise<void> => {
    await this.#core.commands.createPoll(
      targetRoomId,
      question,
      answers,
      undisclosed,
      this.#threadRoot,
      maxSelections
    );
  };

  readonly sendLocation = async (
    targetRoomId: string,
    body: string,
    geoUri: string
  ): Promise<void> => {
    await this.#core.commands.sendLocation(
      targetRoomId,
      body,
      geoUri,
      this.#consumeReply(),
      this.#threadRoot
    );
  };

  readonly schedule = async (
    targetRoomId: string,
    body: string,
    formatted: string | null,
    dueTs: number
  ): Promise<void> => {
    const delayMs = dueTs - Date.now();
    if (delayMs <= 0) return;

    const replacing = this.context?.kind === 'schedule' ? this.context : null;
    await this.#scheduleNew(targetRoomId, body, formatted, dueTs, delayMs);
    if (replacing === null) {
      this.scheduledRevision += 1;
      return;
    }

    this.context = null;
    try {
      if (replacing.scheduled?.source === 'queue') dequeue(replacing.eventId);
      else await this.#core.commands.cancelScheduledMessage(replacing.eventId);
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
    try {
      await this.#core.commands.scheduleMessage(targetRoomId, body, formatted, delayMs);
      return;
    } catch (error) {
      if (!isServerScheduleUnsupported(error)) throw error;
      if (isEncryptedScheduleUnsupported(error) && !preferences.scheduleInEncryptedRooms) {
        throw error;
      }
    }

    enqueue({
      id: crypto.randomUUID(),
      roomId: targetRoomId,
      body,
      formatted,
      dueTs,
      owner: this.#core.session?.device_id ?? '',
    });
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
    await this.#core.commands.setTyping(targetRoomId, typing);
  };

  readonly retrySend = (transactionId: string): void => {
    void this.#core.commands.retrySend(this.#roomId(), transactionId, this.#threadRoot);
  };

  readonly cancelSend = (transactionId: string): void => {
    void this.#core.commands.cancelSend(this.#roomId(), transactionId, this.#threadRoot);
  };

  readonly toggleReaction = (
    eventId: string,
    key: string,
    sourcePack: ImageSourcePackView | null = null
  ): void => {
    const mine = this.#timeline.items
      .find((item) => item.event_id === eventId)
      ?.reactions.some(
        (reaction) =>
          reaction.key === key && reaction.senders.includes(this.#core.session?.user_id ?? '')
      );
    void this.#core.commands.toggleReaction(
      this.#roomId(),
      eventId,
      key,
      this.#threadRoot,
      mine ? null : sourcePack
    );
  };

  readonly votePoll = (eventId: string, answers: string[]): void => {
    void this.#core.commands.votePoll(this.#roomId(), eventId, answers, this.#threadRoot);
  };

  readonly endPoll = (eventId: string): void => {
    void this.#core.commands.endPoll(this.#roomId(), eventId, this.#threadRoot);
  };

  readonly redact = (eventId: string, reason: string | null): void => {
    void this.#core.commands.redact(this.#roomId(), eventId, reason, this.#threadRoot);
  };

  readonly reply = (eventId: string): void => {
    const item = this.#timeline.items.find((entry) => entry.event_id === eventId);
    if (!item) return;

    this.context = {
      kind: 'reply',
      eventId,
      sender: item.sender_name ?? item.sender,
      silentReply: item.sender === this.#core.session?.user_id || !preferences.mentionInReplies,
      body: replyPreviewBody(item.content),
    };
  };

  readonly moveReply = (eventId: string | null): void => {
    if (eventId === null) this.context = null;
    else if (this.context?.kind !== 'reply' || this.context.eventId !== eventId)
      this.reply(eventId);
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
    this.context = { kind: 'edit', eventId, timelineItemId: item?.id, body, html, mediaCaption };
  };

  readonly editLast = (): void => {
    const userId = this.#core.session?.user_id;
    if (!userId) return;

    for (let index = this.#timeline.items.length - 1; index >= 0; index -= 1) {
      const item = this.#timeline.items[index];
      const itemId = item.event_id ?? item.transaction_id;
      if (!itemId || item.sender !== userId) continue;
      if (item.content.kind !== 'message') continue;

      this.edit(itemId, item.content.body, item.content.html);
      return;
    }
  };

  readonly clearContext = (): void => {
    this.context = null;
  };

  readonly forgetRequestedDetails = (): void => {
    this.#requestedDetails.clear();
  };

  readonly fetchMissingReplyDetails = (): void => {
    const roomId = this.#roomId();

    for (const item of this.#timeline.items) {
      const reply = item.in_reply_to;
      if (!reply || reply.body !== null) continue;

      const eventId = item.event_id;
      if (eventId === null || this.#requestedDetails.has(eventId)) continue;

      this.#requestedDetails.add(eventId);
      void this.#core.commands
        .fetchEventDetails(roomId, eventId, this.#threadRoot)
        .catch(async (error: unknown) => {
          console.debug('[sable room] reply details unavailable', error);
          const source = await this.#core.commands.eventSource(roomId, reply.event_id);
          const fallback = replyFallbackFromSource(source, t);
          if (fallback) this.#timeline.provideReplyFallback(reply.event_id, fallback);
        })
        .catch((error: unknown) => {
          console.debug('[sable room] replied-to event unavailable', error);
        });
    }
  };

  #consumeReply(): string | null {
    const replyTo = this.context?.kind === 'reply' ? this.context.eventId : null;
    if (replyTo !== null) this.context = null;
    return replyTo;
  }

  #personaFor(
    targetRoomId: string,
    body: string,
    formatted: string | null
  ): { body: string; formatted: string | null; persona: PerMessageProfileView | null } {
    const personas = this.#personas;
    if (personas.disabledIn(targetRoomId)) return { body, formatted, persona: null };
    const proxied = preferences.personaProxying ? resolveProxy(personas.personas, body) : undefined;
    const persona = resolvePersona({
      personas: personas.personas,
      proxied: proxied?.persona,
      room: personas.selectionFor(targetRoomId) ?? undefined,
      account: personas.selectionFor(null) ?? undefined,
      now: Date.now(),
    });

    if (!persona) return { body, formatted, persona: null };
    if (proxied && preferences.personaLatching !== 'off') {
      void personas
        .select(preferences.personaLatching === 'room' ? targetRoomId : null, proxied.persona.id)
        .catch(() => {});
    }

    return {
      body: proxied?.body ?? body,
      formatted: proxied ? stripProxyHtml(formatted, proxied.trigger) : formatted,
      persona: projectPersona(persona, preferences.personaFallback),
    };
  }
}

function editedKind(edited: TimelineItemView | undefined): MessageKind {
  const content = edited?.content;
  if (content?.kind !== 'message') return 'text';
  if (content.emote) return 'emote';
  return content.notice ? 'notice' : 'text';
}
