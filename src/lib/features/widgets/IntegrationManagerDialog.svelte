<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type { TermsPolicyView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { answerScalarRequest } from './scalar-host.js';

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
  let terms = $state<TermsPolicyView[] | null>(null);
  let accepting = $state(false);
  let acceptFailed = $state(false);
  let attempt = 0;

  function openManager(token: number): void {
    core.rpc.session
      .integrationManagerUrl({ room_id: roomId })
      .then((next) => {
        if (token === attempt) url = next;
      })
      .catch((error: unknown) => {
        console.warn('[sable widgets] the integration manager could not be opened', error);
        if (token === attempt) failed = true;
      });
  }

  async function acceptTerms(): Promise<void> {
    if (terms === null) return;
    const token = attempt;
    accepting = true;
    acceptFailed = false;
    try {
      await core.rpc.session.acceptIntegrationManagerTerms({
        urls: terms.map((policy) => policy.url),
      });
      if (token !== attempt) return;
      terms = null;
      openManager(token);
    } catch (error) {
      console.warn('[sable widgets] the integration manager terms were not accepted', error);
      if (token === attempt) acceptFailed = true;
    } finally {
      accepting = false;
    }
  }

  $effect(() => {
    if (!open) return;
    const token = ++attempt;
    url = null;
    failed = false;
    loaded = false;
    terms = null;
    acceptFailed = false;
    core.rpc.session
      .integrationManagerTerms()
      .catch((error: unknown) => {
        console.debug('[sable widgets] the integration manager terms were not read', error);
        return [];
      })
      .then((pending) => {
        if (token !== attempt) return;
        if (pending.length > 0) terms = pending;
        else openManager(token);
      });
    return () => {
      attempt++;
    };
  });

  function onMessage(event: MessageEvent): void {
    if (!open || url === null || event.origin !== new URL(url).origin) return;
    const request: unknown = event.data;
    if (typeof request !== 'object' || request === null || 'api' in request) return;
    const action = (request as { action?: unknown }).action;
    if (action === 'close_scalar' || action === 'close') {
      onClose();
      return;
    }
    const source = event.source;
    if (typeof action !== 'string' || source === null) return;

    const reply = (response: unknown): void => {
      source.postMessage({ ...request, response }, { targetOrigin: event.origin });
    };
    answerScalarRequest(core.rpc, roomId, core.session?.user_id ?? '', request as never).then(
      reply,
      (error: unknown) => {
        console.warn('[sable widgets] the integration manager request failed', action, error);
        reply({ error: { message: error instanceof Error ? error.message : String(error) } });
      }
    );
  }
</script>

<svelte:window onmessage={onMessage} />

<DialogFrame
  {open}
  variant="fullscreen"
  label={i18n.t('widgets.integrationManager')}
  onOpenChange={(next) => {
    if (!next) onClose();
  }}
>
  <div class="manager">
    <PanelHeader title={i18n.t('widgets.integrationManager')}>
      {#snippet suffix()}
        <PanelHeaderButton label={i18n.t('widgets.close')} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>
    <div class="body">
      {#if failed}
        <Alert variant="critical">{i18n.t('widgets.integrationManagerFailed')}</Alert>
      {:else if terms !== null}
        <div class="terms">
          <h2>{i18n.t('widgets.integrationManagerTermsTitle')}</h2>
          <p>{i18n.t('widgets.integrationManagerTermsBody')}</p>
          <ul>
            {#each terms as policy (policy.url)}
              <li>
                <a href={policy.url} target="_blank" rel="external noopener noreferrer"
                  >{policy.name}</a
                >
              </li>
            {/each}
          </ul>
          {#if acceptFailed}
            <Alert variant="critical">{i18n.t('widgets.integrationManagerTermsFailed')}</Alert>
          {/if}
          <DialogActions>
            <Button variant="ghost" onclick={onClose}>{i18n.t('common.cancel')}</Button>
            <Button variant="primary" loading={accepting} onclick={acceptTerms}>
              {i18n.t('common.accept')}
            </Button>
          </DialogActions>
        </div>
      {:else if url === null}
        <Spinner label={i18n.t('widgets.integrationManagerLoading')} />
      {:else}
        {#if !loaded}
          <div class="loading">
            <Spinner label={i18n.t('widgets.integrationManagerLoading')} />
          </div>
        {/if}
        <iframe
          title={i18n.t('widgets.integrationManager')}
          src={url}
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"
          allow="microphone; camera; encrypted-media; autoplay; clipboard-write; display-capture"
          class={{ loaded }}
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

  .terms {
    display: grid;
    gap: var(--space-300);
    max-width: 32rem;
    padding: var(--space-400);
  }

  .terms ul {
    margin: 0;
    padding-inline-start: var(--space-400);
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
