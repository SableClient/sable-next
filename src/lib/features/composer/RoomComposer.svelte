<script lang="ts">
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';

  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import TextArea from '$lib/ui/primitives/TextArea.svelte';

  interface Props {
    roomId: string;
    onSend: (roomId: string, body: string) => Promise<void>;
    onSendImage: (roomId: string, image: File) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
  }

  let { roomId, onSend, onSendImage, onTyping }: Props = $props();
  let draft = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    return () => {
      if (typingTimeout) clearTimeout(typingTimeout);
      void onTyping(roomId, false);
    };
  });

  function updateTyping(): void {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (!draft.trim()) {
      void onTyping(roomId, false);
      return;
    }

    void onTyping(roomId, true);
    typingTimeout = setTimeout(() => {
      void onTyping(roomId, false);
    }, 4000);
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;

    sending = true;
    error = null;
    draft = '';
    if (typingTimeout) clearTimeout(typingTimeout);
    void onTyping(roomId, false);

    try {
      await onSend(roomId, body);
    } catch {
      draft = body;
      error = $i18n.t('timeline.sendFailed');
    } finally {
      sending = false;
    }
  }

  async function sendImage(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const image = input.files?.[0];
    input.value = '';
    if (!image || sending) return;

    sending = true;
    error = null;
    try {
      await onSendImage(roomId, image);
    } catch {
      error = $i18n.t('timeline.sendFailed');
    } finally {
      sending = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }
</script>

<form
  class="composer"
  onsubmit={(event) => {
    event.preventDefault();
    void send();
  }}
>
  <TextArea
    class="composer-input"
    bind:value={draft}
    rows={1}
    maxlength={4000}
    placeholder={$i18n.t('timeline.messagePlaceholder')}
    aria-label={$i18n.t('timeline.messagePlaceholder')}
    oninput={updateTyping}
    onkeydown={handleKeydown}
  />
  <label class="composer-image" aria-label={$i18n.t('timeline.sendImage')}>
    <ImageIcon />
    <input type="file" accept="image/*" onchange={sendImage} disabled={sending} />
  </label>
  <IconButton
    type="submit"
    variant="ghost"
    size="small"
    class="composer-send"
    loading={sending}
    disabled={!draft.trim()}
    label={$i18n.t('timeline.sendMessage')}
  >
    <PaperPlaneIcon weight="fill" />
  </IconButton>
</form>
{#if error}<Alert class="send-error" variant="critical" role="alert">{error}</Alert>{/if}

<style>
  .composer {
    align-items: end;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: 1.25rem;
    box-shadow: var(--shadow-float);
    display: flex;
    flex: 0 0 auto;
    gap: 0.25rem;
    margin: 0.5rem auto calc(0.75rem + env(safe-area-inset-bottom));
    padding: 0.375rem 0.5rem 0.375rem 0.875rem;
    width: calc(100% - var(--page-gutter) - var(--page-gutter));
  }

  .composer:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .composer :global(textarea.composer-input) {
    background: transparent;
    border: 0;
    border-radius: 0;
    color: inherit;
    field-sizing: content;
    flex: 1;
    max-height: 10rem;
    min-height: var(--control-height-small);
    overflow-y: auto;
    padding: 0.375rem 0;
    resize: none;
  }

  .composer :global(textarea.composer-input:focus-visible) {
    border-color: transparent;
    box-shadow: none;
    outline: 0;
  }

  :global(.composer-send) {
    color: var(--sable-primary-main);
  }

  .composer-image {
    align-items: center;
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    height: var(--control-height-small);
    justify-content: center;
    width: var(--control-height-small);
  }

  .composer-image:hover {
    background: var(--sable-surface-container-hover);
  }

  .composer-image:has(input:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  .composer-image input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .composer-image :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-send:disabled) {
    color: var(--sable-sec-main);
  }

  :global(.composer-send:not(:disabled):hover),
  :global(.composer-send:not(:disabled):focus-visible) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-send svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.send-error) {
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
