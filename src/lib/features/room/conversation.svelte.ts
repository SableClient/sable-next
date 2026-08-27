import type { MessageKind } from '#src/generated/MessageKind';
import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';

import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { runtimeConfig } from '#lib/config/runtime-config.js';
import type { CoreClient, OutgoingMentions } from '#lib/core/client.svelte.js';
import type { ComposerContext } from '#lib/features/composer/composer-context.js';
import { runSlash } from '#lib/features/composer/slash-commands.js';
import { gifFilename, proxiedGif, type GifResult } from '#lib/features/gif/providers.js';
import { projectPersona, resolvePersona, resolveProxy } from '#lib/personas/persona.js';
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
  threadRoot?: string | null;
};

export class Conversation {
  context = $state<ComposerContext | null>(null);

  readonly #core: CoreClient;
  readonly #personas: PersonaStore;
  readonly #timeline: RoomTimeline;
  readonly #roomId: () => string;
  readonly #threadRoot: string | null;
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  readonly #requestedDetails = new Set<string>();

  constructor({ core, personas, timeline, roomId, threadRoot = null }: ConversationDeps) {
    this.#core = core;
    this.#personas = personas;
    this.#timeline = timeline;
    this.#roomId = roomId;
    this.#threadRoot = threadRoot;
  }

  get threadRoot(): string | null {
    return this.#threadRoot;
  }

  readonly sendMessage = async (
    targetRoomId: string,
    body: string,
    formatted: string | null = null,
    mentions: OutgoingMentions = NO_MENTIONS
  ): Promise<ConversationSendResult | undefined> => {
    const pending = this.context;
    if (body === '') return;

    if (pending?.kind === 'edit') {
      const edited = this.#timeline.items.find((entry) => entry.event_id === pending.eventId);
      await this.#core.commands.editMessage(targetRoomId, pending.eventId, body, {
        formatted,
        mentions,
        kind: editedKind(edited),
        threadRoot: this.#threadRoot,
        persona: edited?.per_message_profile ?? null,
      });
      this.context = null;
      return;
    }

    const outcome = await runSlash(body, {
      roomId: targetRoomId,
      userId: this.#core.session?.user_id ?? null,
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

    const rewritten = outcome.body !== body;
    const outgoing = this.#personaFor(
      targetRoomId,
      outcome.body,
      rewritten ? (outcome.formatted ?? null) : (outcome.formatted ?? formatted)
    );
    await this.#core.commands.sendMessage(targetRoomId, outgoing.body, {
      inReplyTo: pending?.eventId ?? null,
      threadRoot: this.#threadRoot,
      formatted: outgoing.formatted,
      mentions: rewritten ? NO_MENTIONS : mentions,
      kind: outcome.msgtype,
      persona: outgoing.persona,
    });
    this.context = null;
  };

  readonly sendAttachment = async (
    targetRoomId: string,
    file: File,
    options: { caption?: string } = {}
  ): Promise<void> => {
    await this.#core.commands.sendAttachment(targetRoomId, file, {
      caption: options.caption,
      inReplyTo: this.#consumeReply(),
      threadRoot: this.#threadRoot,
    });
  };

  readonly sendSticker = async (targetRoomId: string, url: string, body: string): Promise<void> => {
    await this.#core.commands.sendSticker(
      targetRoomId,
      url,
      body,
      this.#consumeReply(),
      this.#threadRoot
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
      gif.size > 0 && proxied.mimetype === gif.mimetype ? gif.size : null,
      this.#consumeReply(),
      this.#threadRoot
    );
  };

  readonly createPoll = async (
    targetRoomId: string,
    question: string,
    answers: string[],
    undisclosed: boolean
  ): Promise<void> => {
    await this.#core.commands.createPoll(
      targetRoomId,
      question,
      answers,
      undisclosed,
      1,
      this.#threadRoot
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

  readonly toggleReaction = (eventId: string, key: string): void => {
    void this.#core.commands.toggleReaction(this.#roomId(), eventId, key, this.#threadRoot);
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
    if (!item || (item.content.kind !== 'message' && item.content.kind !== 'image')) return;

    this.context = {
      kind: 'reply',
      eventId,
      sender: item.sender_name ?? item.sender,
      body: item.content.body,
    };
  };

  readonly edit = (eventId: string, body: string, html: string | null = null): void => {
    this.context = { kind: 'edit', eventId, body, html };
  };

  readonly editLast = (): void => {
    const userId = this.#core.session?.user_id;
    if (!userId) return;

    for (let index = this.#timeline.items.length - 1; index >= 0; index -= 1) {
      const item = this.#timeline.items[index];
      if (!item.event_id || item.sender !== userId) continue;
      if (item.content.kind !== 'message') continue;

      this.edit(item.event_id, item.content.body, item.content.html);
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
        .catch((error: unknown) => {
          console.debug('[sable room] reply details unavailable', error);
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
    const proxied = preferences.personaProxying ? resolveProxy(personas.personas, body) : undefined;
    const persona = resolvePersona({
      personas: personas.personas,
      proxied: proxied?.persona,
      room: personas.selectionFor(targetRoomId) ?? undefined,
      account: personas.selectionFor(null) ?? undefined,
      now: Date.now(),
    });

    if (!persona) return { body, formatted, persona: null };
    if (proxied && preferences.personaLatching) {
      void personas.select(targetRoomId, proxied.persona.id).catch(() => {});
    }

    return {
      body: proxied?.body ?? body,
      formatted: proxied ? null : formatted,
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
