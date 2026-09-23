<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import RoomComposer from '#lib/features/composer/RoomComposer.svelte';

  import type { Conversation } from './conversation.svelte.js';

  type ComposerProps = ComponentProps<typeof RoomComposer>;

  type Props = Omit<
    ComposerProps,
    | 'onSend'
    | 'onSendAttachment'
    | 'onSendGallery'
    | 'onSendSticker'
    | 'onSendGif'
    | 'onCreatePoll'
    | 'onSendLocation'
    | 'onTyping'
    | 'context'
    | 'onCancelContext'
    | 'onToggleSilentReply'
  > & {
    conversation: Conversation;
    onSend?: ComposerProps['onSend'];
  };

  let { conversation, onSend = conversation.sendMessage, ...rest }: Props = $props();

  let composer = $state<RoomComposer>();

  export function insertMention(userId: string, name: string): void {
    composer?.insertMention(userId, name);
  }
</script>

<RoomComposer
  bind:this={composer}
  {...rest}
  {onSend}
  onSendAttachment={conversation.sendAttachment}
  onSendGallery={conversation.sendGallery}
  onSendSticker={conversation.sendSticker}
  onSendGif={conversation.sendGif}
  onCreatePoll={conversation.createPoll}
  onSendLocation={conversation.sendLocation}
  onTyping={conversation.setTyping}
  context={conversation.context}
  onCancelContext={conversation.clearContext}
  onToggleSilentReply={conversation.toggleSilentReply}
/>
