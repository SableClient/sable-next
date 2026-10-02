<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { on } from 'svelte/events';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  interface Props {
    open: boolean;
    roomId: string;
    onClose: () => void;
  }

  let { open, roomId, onClose }: Props = $props();

  const core = useCoreClient();

  let url = $state<string | null>(null);
  let failed = $state(false);
  let loaded = $state(false);

  $effect(() => {
    if (!open) return;
    let current = true;
    url = null;
    failed = false;
    loaded = false;
    core.commands
      .integrationManagerUrl(roomId)
      .then((next) => {
        if (current) url = next;
      })
      .catch(() => {
        if (current) failed = true;
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (!open || url === null) return;
    const origin = new URL(url).origin;
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== origin) return;
      const action = (event.data as { action?: unknown } | null)?.action;
      if (action === 'close_scalar' || action === 'close') onClose();
    };
    return on(window, 'message', onMessage);
  });
</script>

<DialogFrame
  {open}
  variant="fullscreen"
  label={$i18n.t('widgets.integrationManager')}
  onOpenChange={(next) => {
    if (!next) onClose();
  }}
>
  <div class="manager">
    <PanelHeader title={$i18n.t('widgets.integrationManager')}>
      {#snippet suffix()}
        <PanelHeaderButton label={$i18n.t('widgets.close')} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>
    <div class="body">
      {#if failed}
        <Alert variant="critical">{$i18n.t('widgets.integrationManagerFailed')}</Alert>
      {:else if url === null}
        <Spinner label={$i18n.t('widgets.integrationManagerLoading')} />
      {:else}
        {#if !loaded}
          <div class="loading">
            <Spinner label={$i18n.t('widgets.integrationManagerLoading')} />
          </div>
        {/if}
        <iframe
          title={$i18n.t('widgets.integrationManager')}
          src={url}
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="microphone; camera; encrypted-media; autoplay; clipboard-write; display-capture"
          class:loaded
          onload={() => (loaded = true)}
        ></iframe>
      {/if}
    </div>
  </div>
</DialogFrame>

<style>
  .manager {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
  }

  .body {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 0;
    position: relative;
  }

  .loading {
    position: absolute;
  }

  iframe {
    border: 0;
    height: 100%;
    opacity: 0;
    width: 100%;
  }

  iframe.loaded {
    opacity: 1;
  }
</style>
