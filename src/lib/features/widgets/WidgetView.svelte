<script lang="ts">
  import { type CapabilityDecision, approveCapabilities } from './capabilities.js';
  import type { RoomWidget } from './widget-content.js';
  import WidgetCapabilitiesDialog from './WidgetCapabilitiesDialog.svelte';
  import WidgetFrame from './WidgetFrame.svelte';

  interface Props {
    roomId: string;
    widget: RoomWidget;
    url: string;
    permissionKey: string;
  }

  let { roomId, widget, url, permissionKey }: Props = $props();

  interface PendingApproval {
    requested: string[];
    settle: (decision: CapabilityDecision) => void;
  }

  let approval = $state.raw<PendingApproval | null>(null);

  function requestCapabilities(requested: Set<string>): Promise<Set<string>> {
    return approveCapabilities(
      permissionKey,
      requested,
      (missing) =>
        new Promise<CapabilityDecision>((settle) => {
          approval = {
            requested: missing,
            settle: (decision) => {
              approval = null;
              settle(decision);
            },
          };
        })
    );
  }

  $effect(() => () => approval?.settle({ approved: [], remember: false }));
</script>

<div class="widgets-frame">
  <WidgetFrame
    {roomId}
    widgetId={widget.id}
    {url}
    name={widget.name}
    onCapabilities={requestCapabilities}
  />
</div>

{#if approval}
  {@const pending = approval}
  <WidgetCapabilitiesDialog
    open
    widgetName={widget.name}
    requested={pending.requested}
    onDecide={pending.settle}
  />
{/if}

<style>
  .widgets-frame {
    border: none;
    box-sizing: border-box;
    display: block;
    height: 100%;
    max-width: 100%;
    width: 100%;
  }
</style>
