<script lang="ts">
  import { untrack } from 'svelte';
  import { type Capability, ClientWidgetApi, Widget } from 'matrix-widget-api';

  import { useCoreClient } from '#lib/core/context.js';

  import { SableWidgetDriver } from './widget-driver.js';

  interface Props {
    roomId: string;
    widgetId: string;
    url: string;
    name: string;
    onCapabilities: (requested: Set<Capability>) => Promise<Set<Capability>>;
  }

  let { roomId, widgetId, url, name, onCapabilities }: Props = $props();

  const core = useCoreClient();

  function widget(node: HTMLIFrameElement) {
    const definition = untrack(() => ({
      id: widgetId,
      creatorUserId: core.session?.user_id ?? '',
      type: 'm.custom',
      url,
      waitForIframeLoad: true,
    }));
    const room = untrack(() => roomId);
    const approve = untrack(() => onCapabilities);

    if (!node.contentWindow) return;

    const driver = new SableWidgetDriver(core, room, approve);
    const api = new ClientWidgetApi(new Widget(definition), node, driver);
    api.setViewedRoomId(room);

    const onReady = (): void => {
      api.updateVisibility(true).catch(() => undefined);
    };
    api.once('ready', onReady);

    return () => {
      api.off('ready', onReady);
      api.stop();
    };
  }
</script>

<iframe
  class="widget-frame"
  title={name}
  src={url}
  allow="autoplay; camera; clipboard-write; compute-pressure; display-capture; hid; microphone; screen-wake-lock"
  sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads"
  {@attach widget}
></iframe>

<style>
  .widget-frame {
    background: var(--sable-surface-container);
    border: 0;
    border-radius: var(--radius);
    height: 100%;
    width: 100%;
  }
</style>
