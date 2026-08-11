<script lang="ts">
  import PaperPlaneIcon from 'phosphor-icons-svelte/IconPaperPlaneTiltFill.svelte';

  import { i18n } from '$lib/i18n';

  interface Props {
    roomId: string;
    onSend: (roomId: string, body: string) => Promise<void>;
    onTyping: (roomId: string, typing: boolean) => Promise<void>;
  }

  let { roomId, onSend, onTyping }: Props = $props();
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
  <textarea
    bind:value={draft}
    rows="1"
    placeholder={$i18n.t('timeline.messagePlaceholder')}
    aria-label={$i18n.t('timeline.messagePlaceholder')}
    oninput={updateTyping}
    onkeydown={handleKeydown}></textarea>
  <button
    type="submit"
    disabled={sending || !draft.trim()}
    aria-label={$i18n.t('timeline.sendMessage')}
  >
    <PaperPlaneIcon />
  </button>
</form>
{#if error}<p class="send-error" role="alert">{error}</p>{/if}

<style>
  .composer {
    align-items: end;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: 1.25rem;
    box-shadow: 0 0.25rem 0.75rem var(--sable-shadow);
    display: flex;
    flex: 0 0 auto;
    gap: 0.25rem;
    margin: 0.5rem 0.75rem 0.75rem;
    padding: 0.375rem 0.5rem 0.375rem 0.875rem;
  }

  textarea {
    background: transparent;
    border: 0;
    border-radius: 0;
    color: inherit;
    flex: 1;
    max-height: 10rem;
    min-height: 2.25rem;
    padding: 0.375rem 0;
    resize: vertical;
  }

  textarea:focus-visible {
    outline: 0;
  }

  button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 50%;
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    height: 2.25rem;
    justify-content: center;
    padding: 0;
    width: 2.25rem;
  }

  button:disabled {
    color: var(--sable-sec-main);
    cursor: default;
  }

  button:not(:disabled):hover,
  button:not(:disabled):focus-visible {
    background: var(--sable-surface-container-hover);
  }

  button :global(svg) {
    height: 1.125rem;
    width: 1.125rem;
  }

  .send-error {
    background: var(--sable-crit-container);
    color: var(--sable-crit-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0.5rem 1rem;
  }
</style>
