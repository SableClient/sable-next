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
    typingLabel?: string | null;
  }

  let { roomId, onSend, onSendImage, onTyping, typingLabel = null }: Props = $props();
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

<div class="composer-stack">
  <div class="composer-shell">
    <form
      class="composer"
      class:typing-visible={typingLabel !== null}
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div
        class="typing-indicator"
        class:visible={typingLabel !== null}
        aria-hidden={typingLabel === null}
        aria-live="polite"
        role="status"
      >
        <div class="typing-content">
          {#if typingLabel}
            <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="typing-label">{typingLabel}</span>
          {/if}
        </div>
      </div>
      <div class="composer-row">
        <label class="composer-image" aria-label={$i18n.t('timeline.sendImage')}>
          <ImageIcon />
          <input type="file" accept="image/*" onchange={sendImage} disabled={sending} />
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
      </div>
    </form>
  </div>
  {#if error}<Alert class="send-error" variant="critical" role="alert">{error}</Alert>{/if}
</div>

<style>
  .composer-stack {
    margin: 0 auto calc(0.5rem + env(safe-area-inset-bottom));
    position: relative;
    width: calc(100% - var(--page-gutter) - var(--page-gutter));
  }

  .composer-shell {
    align-items: end;
    display: flex;
    min-height: calc(var(--control-height-medium) + 1.375rem);
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
    padding: 0.375rem 0.5rem;
    position: relative;
    width: 100%;
  }

  .composer.typing-visible {
    padding-top: 0.5rem;
  }

  .composer:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .typing-indicator {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1rem;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    transform: translateY(0.25rem);
    white-space: nowrap;
  }

  .typing-indicator.visible {
    max-height: 1.125rem;
    opacity: 1;
    transform: translateY(0);
  }

  .typing-content {
    align-items: center;
    display: flex;
    gap: var(--space-1);
    height: 1.125rem;
    justify-content: flex-start;
    min-width: 0;
    overflow: hidden;
    padding: 0 var(--space-3) 0.125rem calc(var(--control-height-small) + 0.25rem);
  }

  .typing-dots {
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    gap: 0.1875rem;
  }

  .typing-dots i {
    background: var(--sable-sec-main);
    border-radius: 50%;
    height: 0.25rem;
    width: 0.25rem;
  }

  .typing-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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

    .typing-indicator {
      transition:
        max-height var(--motion-slow) var(--motion-easing-emphasized),
        opacity var(--motion-normal) var(--motion-easing-standard),
        transform var(--motion-slow) var(--motion-easing-emphasized);
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
      opacity: 0.35;
      transform: scale(0.8);
    }

    30% {
      opacity: 1;
      transform: scale(1);
    }
  }

  :global(.send-error) {
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
