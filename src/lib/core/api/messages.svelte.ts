import type { ComposerMentions, Rpc, RpcParams } from '#src/generated/protocol';

export type OutgoingMentions = ComposerMentions;

const noMentions: OutgoingMentions = { user_ids: [], room: false };

type SendParams = RpcParams<Rpc['messages']['send']>;

export type SendMessageOptions = Omit<
  Partial<SendParams>,
  'room_id' | 'body' | 'mentions' | 'mentions_room'
> & {
  mentions?: OutgoingMentions;
};

type EditParams = RpcParams<Rpc['messages']['edit']>;

export type EditMessageOptions = Omit<
  Partial<EditParams>,
  'room_id' | 'event_id' | 'body' | 'mentions' | 'mentions_room'
> & {
  mentions?: OutgoingMentions;
};

export async function sendMessage(
  rpc: Rpc,
  roomId: string,
  body: string,
  options: SendMessageOptions = {}
): Promise<void> {
  const mentions = options.mentions ?? noMentions;
  await rpc.messages.send({
    room_id: roomId,
    body,
    formatted: options.formatted ?? null,
    kind: options.kind ?? 'text',
    thread_root: options.thread_root ?? null,
    in_reply_to: options.in_reply_to ?? null,
    mentions: [...mentions.user_ids],
    mentions_room: mentions.room,
    silent_reply: options.silent_reply ?? false,
    persona: $state.snapshot(options.persona ?? null),
    link_previews: $state.snapshot(options.link_previews ?? []),
    no_link_previews: options.no_link_previews ?? false,
    image_source_packs: $state.snapshot(options.image_source_packs ?? []),
    bot_command: $state.snapshot(options.bot_command ?? null),
    forum_title: options.forum_title ?? null,
  });
}

export async function editMessage(
  rpc: Rpc,
  roomId: string,
  eventId: string | null,
  body: string,
  options: EditMessageOptions = {}
): Promise<void> {
  const mentions = options.mentions ?? noMentions;
  await rpc.messages.edit({
    room_id: roomId,
    event_id: eventId,
    transaction_id: options.transaction_id ?? null,
    body,
    formatted: options.formatted ?? null,
    kind: options.kind ?? 'text',
    media_caption: options.media_caption ?? false,
    thread_root: options.thread_root ?? null,
    mentions: [...mentions.user_ids],
    mentions_room: mentions.room,
    persona: $state.snapshot(options.persona ?? null),
    forum_title: options.forum_title ?? null,
  });
}
