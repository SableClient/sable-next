<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import VideoIcon from 'phosphor-svelte/lib/VideoIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import type { Snippet } from 'svelte';

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
    statusTrailing?: Snippet;
  }

  interface StagedFile {
    id: number;
    file: File;
  }

  let {
    roomId,
    onSend,
    onSendAttachment,
    onTyping,
    typingLabel = null,
    statusTrailing,
  }: Props = $props();
  let draft = $state('');
  let staged = $state<StagedFile[]>([]);
  let sending = $state(false);
  let error = $state<string | null>(null);
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let fileInput = $state<HTMLInputElement | null>(null);
  let nextStagedId = 0;

  let hasContent = $derived(draft.trim().length > 0 || staged.length > 0);

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
    const attachments = staged;
    if (!hasContent || sending) return;

    sending = true;
    error = null;
    draft = '';
    staged = [];
    if (typingTimeout) clearTimeout(typingTimeout);
    void onTyping(roomId, false);

    try {
      for (const { file } of attachments) await onSendAttachment(roomId, file);
      if (body) await onSend(roomId, body);
    } catch {
      draft = body;
      staged = attachments;
      error = $i18n.t('timeline.sendFailed');
    } finally {
      sending = false;
    }
  }

  function stage(files: File[]): void {
    if (files.length === 0) return;
    staged = [...staged, ...files.map((file) => ({ id: nextStagedId++, file }))];
  }

  function unstage(id: number): void {
    staged = staged.filter((item) => item.id !== id);
  }

  function filesFrom(dataTransfer: DataTransfer | null): File[] {
    if (!dataTransfer) return [];
    return Array.from(dataTransfer.files).filter((file): file is File => file instanceof File);
  }

  /** The door's two items share one input, so the picker opens on the type the user asked for. */
  function pick(accept: string): void {
    if (!fileInput) return;
    fileInput.accept = accept;
    fileInput.click();
  }

  function stageFromInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    stage(input.files ? Array.from(input.files) : []);
    input.value = '';
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = filesFrom(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    stage(files);
  }

  function handleDrop(event: DragEvent): void {
    const files = filesFrom(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    stage(files);
  }

  function handleDragover(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="composer-stack">
  <div class="status-row">
    <div class="typing" aria-hidden={typingLabel === null} aria-live="polite" role="status">
      {#if typingLabel}
        <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>{typingLabel}</span>
      {/if}
    </div>
    {#if statusTrailing}
      {@render statusTrailing()}
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
      {#if staged.length > 0}
        <ul class="staged" aria-label={$i18n.t('composer.stagedFiles')}>
          {#each staged as item (item.id)}
            <li class="staged-item">
              <span class="staged-icon" aria-hidden="true">
                {#if item.file.type.startsWith('image/')}
                  <ImageIcon />
                {:else if item.file.type.startsWith('video/')}
                  <VideoIcon />
                {:else}
                  <FileIcon />
                {/if}
              </span>
              <span class="staged-text">
                <span class="staged-name">{item.file.name}</span>
                <span class="staged-size">{formatSize(item.file.size)}</span>
              </span>
              <IconButton
                variant="ghost"
                size="small"
                class="staged-remove"
                disabled={sending}
                label={$i18n.t('composer.removeAttachment', { name: item.file.name })}
                onclick={() => {
                  unstage(item.id);
                }}
              >
                <XIcon />
              </IconButton>
            </li>
          {/each}
        </ul>
      {/if}
      <form
        class="composer-row"
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="composer-door"
            disabled={sending}
            aria-label={$i18n.t('composer.insert')}
          >
            <PlusIcon />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="composer-menu" side="top" align="start" sideOffset={8}>
            <DropdownMenu.Item
              onclick={() => {
                pick('image/*,video/*');
              }}
            >
              <ImageIcon />
              {$i18n.t('composer.photoOrVideo')}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onclick={() => {
                pick('*');
              }}
            >
              <PaperclipIcon />
              {$i18n.t('composer.attachFile')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <input
          bind:this={fileInput}
          class="composer-file"
          type="file"
          multiple
          tabindex="-1"
          aria-hidden="true"
          onchange={stageFromInput}
        />
        <TextArea
          class="composer-input"
          bind:value={draft}
          rows={1}
          maxlength={4000}
          placeholder={staged.length > 0
            ? $i18n.t('composer.addMessageOrSend')
            : $i18n.t('timeline.messagePlaceholder')}
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
          disabled={!hasContent}
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

  .status-row {
    align-items: center;
    display: flex;
    gap: 0.75rem;
    justify-content: space-between;
    min-height: 1.75rem;
  }

  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
    line-height: 1.25rem;
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

  .composer:has(.staged) {
    border-radius: var(--radius);
  }

  .composer:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .staged {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    list-style: none;
    margin: 0;
    max-height: 7.5rem;
    overflow-y: auto;
    padding: 0.5rem 0 0.375rem;
  }

  .staged-item {
    align-items: center;
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: 0.375rem;
    max-width: 14rem;
    min-width: 0;
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  }

  .staged-icon {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }

  .staged-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  /* min-width:0 on both the flex item and the name is what lets the ellipsis
     win over the intrinsic width of a long filename. */
  .staged-text {
    display: grid;
    line-height: 1.15;
    min-width: 0;
  }

  .staged-name {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staged-size {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  :global(.staged-remove) {
    flex: 0 0 auto;
  }

  :global(.staged-remove svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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

  .composer-file {
    height: 1px;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    width: 1px;
  }

  :global(.composer-door) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-small);
    justify-content: center;
    width: var(--control-height-small);
  }

  :global(.composer-door:hover) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-door[data-state='open']) {
    background: var(--sable-surface-container-active);
  }

  :global(.composer-door:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  :global(.composer-door svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-menu) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem;
    width: min(15rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }

  :global(.composer-menu [role='menuitem']) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 0.125rem);
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: var(--space-1);
    padding: 0.5rem 0.625rem;
    text-align: left;
  }

  :global(.composer-menu [role='menuitem']:hover),
  :global(.composer-menu [role='menuitem'][data-highlighted]) {
    background: var(--sable-bg-container-hover);
  }

  :global(.composer-menu [role='menuitem'] svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-send) {
    color: var(--sable-primary-main);
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

    :global(.composer-door) {
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
