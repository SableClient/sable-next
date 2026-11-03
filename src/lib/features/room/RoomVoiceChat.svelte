<script lang="ts">
  import type { Snippet } from 'svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { voiceChat } from '#lib/features/room/voice-chat.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import type { PanelWidth } from '#lib/ui/panel-width.svelte.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';

  interface Props {
    covered: boolean;
    size: PanelWidth;
    children: Snippet;
  }

  let { covered, size, children }: Props = $props();
</script>

<aside
  class={['voice-chat', { 'thread-covered': covered }]}
  inert={covered}
  style:width="{size.width}px"
  aria-label={i18n.t('call.chat')}
  data-focus-region="panel"
>
  <ResizeHandle
    value={size.width}
    min={size.min}
    max={size.max}
    label={i18n.t('call.chat')}
    grow="left"
    step={16}
    shiftStep={64}
    onResize={(next) => size.resize(next)}
    onCommit={() => size.commit()}
  />
  <PanelHeader class="voice-chat-header" title={i18n.t('call.chat')}>
    {#snippet suffix()}
      <PanelHeaderButton label={i18n.t('call.closeChat')} onclick={() => (voiceChat.open = false)}>
        <XIcon />
      </PanelHeaderButton>
    {/snippet}
  </PanelHeader>
  {@render children()}
</aside>

<style>
  .voice-chat.thread-covered {
    inset: 0;
    pointer-events: none;
    position: absolute;
    visibility: hidden;
  }

  .voice-chat {
    background: var(--surface-container);
    border-left: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    max-width: 60%;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .voice-chat :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }
</style>
