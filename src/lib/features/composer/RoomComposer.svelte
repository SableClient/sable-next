<script lang="ts">
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';

  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import TextArea from '$lib/ui/primitives/TextArea.svelte';

  interface Props {
    roomId: string;
    onSend: (roomId: string, body: string) => Promise<void>;
    onSendAttachment: (roomId: string, file: File) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
    typingLabel?: string | null;
  }

  let { roomId, onSend, onSendAttachment, onTyping, typingLabel = null }: Props = $props();
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

  async function sendAttachments(files: File[]): Promise<void> {
    if (files.length === 0 || sending) return;

    sending = true;
    error = null;
    try {
      for (const file of files) await onSendAttachment(roomId, file);
    } catch {
      error = $i18n.t('timeline.sendFailed');
    } finally {
      sending = false;
    }
  }

  function filesFrom(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];
    return Array.from(dataTransfer.files).filter((file): file is File => file instanceof File);
  }

  function sendAttachment(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    void sendAttachments(files);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = filesFrom(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void sendAttachments(files);
  }

  function handleDrop(event: DragEvent): void {
    const files = filesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void sendAttachments(files);
  }

  function handleDragover(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }
</script>

<div class="composer-stack">
  <div class="typing" aria-hidden={typingLabel === null} aria-live="polite" role="status">
    {#if typingLabel}
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>{typingLabel}</span>
    {/if}
  </div>
  <div class="composer-shell">
    <div
      class="composer"
      role="group"
      aria-label={$i18n.t('timeline.messagePlaceholder')}
      ondrop={handleDrop}
      ondragover={handleDragover}
    >
      <form
        class="composer-row"
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label class="composer-image" aria-label={$i18n.t('timeline.sendAttachment')}>
          <PaperclipIcon />
          <input type="file" onchange={sendAttachment} disabled={sending} />
        </label>
        <TextArea
          class="composer-input"
          bind:value={draft}
          rows={1}
          maxlength={4000}
          placeholder={$i18n.t('timeline.messagePlaceholder')}
          aria-label={$i18n.t('timeline.messagePlaceholder')}
          oninput={updateTyping}
          onkeydown={handleKeydown}
          onpaste={handlePaste}
        />
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
    </div>
  </div>
  {#if error}<Alert class="send-error" variant="critical" role="alert">{error}</Alert>{/if}
</div>

<style>
  .composer-stack {
    margin: 0 auto calc(0.5rem + env(safe-area-inset-bottom));
    position: relative;
    width: calc(100% - var(--page-gutter) - var(--page-gutter));
  }

  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    line-height: 1.25rem;
    min-height: 1.25rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .typing-dots {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 0.1875rem;
  }

  .typing-dots i {
    background: var(--sable-primary-main);
    border-radius: 50%;
    height: 0.25rem;
    width: 0.25rem;
  }

  .typing-dots i:nth-child(2) {
    animation-delay: 0.15s;
  }

  .typing-dots i:nth-child(3) {
    animation-delay: 0.3s;
  }

  .composer-shell {
    align-items: end;
    display: flex;
    position: relative;
  }

  .composer {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-float);
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    padding: 0 0.5rem 0.375rem;
    position: relative;
    width: 100%;
  }

  .composer:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .composer-row {
    align-items: end;
    display: flex;
    gap: 0.25rem;
    width: 100%;
  }

  .composer :global(textarea.composer-input) {
    background: transparent;
    border: 0;
    border-radius: 0;
    color: inherit;
    field-sizing: content;
    flex: 1;
    interpolate-size: allow-keywords;
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

  .composer-image:active {
    background: var(--sable-surface-container-active);
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

  @media (prefers-reduced-motion: no-preference) {
    .composer {
      transition:
        border-color var(--motion-fast) var(--motion-easing-standard),
        box-shadow var(--motion-fast) var(--motion-easing-standard),
        padding var(--motion-slow) var(--motion-easing-emphasized);
    }

    .composer :global(textarea.composer-input) {
      transition: block-size var(--motion-normal) var(--motion-easing-emphasized);
    }

    .composer-image:active {
      transition: background-color var(--motion-normal) var(--motion-easing-standard);
    }

    .typing-dots i {
      animation: typing-dot 1.2s infinite ease-in-out;
    }

    .typing-dots i:nth-child(2) {
      animation-delay: 0.15s;
    }

    .typing-dots i:nth-child(3) {
      animation-delay: 0.3s;
    }
  }

  @keyframes typing-dot {
    0%,
    60%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }

    30% {
      opacity: 1;
      transform: translateY(-0.1875rem);
    }
  }

  :global(.send-error) {
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
