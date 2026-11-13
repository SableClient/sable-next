<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import { useCallSession } from '#lib/features/call/call-session.svelte.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import type { PanelWidth } from '#lib/ui/panel-width.svelte.js';

  interface Props {
    docked: boolean;
    ratio: PanelWidth;
    timelineHeight: number;
    members: MemberView[];
    onInvite?: () => void;
  }

  let { docked, ratio, timelineHeight, members, onInvite }: Props = $props();
  const call = useCallSession();
</script>

<div
  class={['call-stage', { docked }]}
  style:flex-basis={docked ? `${ratio.width * 100}%` : undefined}
>
  {#await import('#lib/features/call/CallView.svelte') then { default: CallView }}
    <CallView
      session={call}
      {members}
      {onInvite}
      onOpenSettings={(event: MouseEvent) => openSettingsOver(event, 'calls')}
    />
  {/await}
  {#if docked}
    <ResizeHandle
      value={ratio.width}
      min={ratio.min}
      max={ratio.max}
      label={i18n.t('call.resizeStage')}
      valueText={i18n.t('call.stageShare', { percent: Math.round(ratio.width * 100) })}
      grow="down"
      step={0.05}
      shiftStep={0.15}
      fromPixels={(pixels) => (timelineHeight > 0 ? pixels / timelineHeight : 0)}
      onResize={(next) => ratio.resize(next)}
      onCommit={() => ratio.commit()}
    />
  {/if}
</div>

<style>
  .call-stage {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .call-stage.docked {
    flex-grow: 0;
    flex-shrink: 0;
    min-height: 10rem;
  }

  .call-stage :global(.resize-handle) {
    bottom: -0.25rem;
    z-index: 3;
  }

  .call-stage :global(.resize-handle)::after {
    background: var(--surface-container-line);
    border-radius: var(--radii-pill);
    content: '';
    height: 0.25rem;
    /* stylelint-disable-next-line csstools/use-logical -- centred, so the same in both directions */
    left: 50%;
    position: absolute;
    top: 50%;
    translate: -50% -50%;
    width: 2.5rem;
  }
</style>
