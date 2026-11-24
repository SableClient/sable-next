<script lang="ts">
  import { mergeProps } from 'bits-ui';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import PaperPlaneIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import { onDestroy } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import { LongPress, SCHEDULE_PRESS_MS, touchContextMenu } from '#lib/ui/long-press.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import type { ComposerContext } from '#lib/composer/composer-context.js';

  interface Props {
    context: ComposerContext | null;
    hasContent: boolean;
    canDelete: boolean;
    canSchedule: boolean;
    sending: boolean;
    desktop: boolean;
    shortcut: string;
    onSchedule: () => void;
  }

  let {
    context,
    hasContent,
    canDelete,
    canSchedule,
    sending,
    desktop,
    shortcut,
    onSchedule,
  }: Props = $props();

  let editingScheduled = $derived(context?.kind === 'schedule');
  let sendLabel = $derived(
    editingScheduled
      ? i18n.t('composer.scheduledSave')
      : context?.kind === 'edit'
        ? !hasContent && canDelete
          ? i18n.t('timeline.deleteMessage')
          : i18n.t('composer.saveChanges')
        : i18n.t('timeline.sendMessage')
  );
  let sendTooltip = $derived(
    desktop
      ? i18n.t(canSchedule ? 'composer.sendScheduleTooltip' : 'composer.sendTooltip', {
          action: sendLabel,
          shortcut,
        })
      : canSchedule
        ? i18n.t('composer.scheduleTooltip', { action: sendLabel })
        : sendLabel
  );

  const sendPress = new LongPress({
    enabled: () => canSchedule,
    delayMs: SCHEDULE_PRESS_MS,
    onPress: () => {
      onSchedule();
    },
  });

  onDestroy(() => {
    sendPress.cancel();
  });
</script>

<Tooltip label={sendTooltip}>
  {#snippet trigger({ props })}
    <IconButton
      {...mergeProps(props, {
        onpointerdown: sendPress.start,
        onpointermove: sendPress.move,
        onpointerup: sendPress.lift,
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            sendPress.touch = false;
          }
        },
      })}
      type="submit"
      variant="ghost"
      size="small"
      class="composer-send"
      data-pressing={sendPress.pressing || undefined}
      style="--press-ms: {SCHEDULE_PRESS_MS}ms"
      disabled={!hasContent && !canDelete}
      aria-busy={sending || undefined}
      label={sendLabel}
      onpointercancel={sendPress.end}
      oncontextmenu={(event: MouseEvent) => {
        if (sendPress.touch || touchContextMenu(event)) {
          event.preventDefault();
          return;
        }
        if (!canSchedule) return;
        event.preventDefault();
        onSchedule();
      }}
      onmousedown={(event: MouseEvent) => {
        if (hasContent) event.preventDefault();
      }}
    >
      {#if sending}
        <Spinner small />
      {:else if context?.kind === 'edit' || editingScheduled}
        {#if !hasContent && canDelete}
          <TrashIcon />
        {:else}
          <CheckIcon weight="bold" />
        {/if}
      {:else}
        <PaperPlaneIcon weight="fill" />
      {/if}
    </IconButton>
  {/snippet}
</Tooltip>
<span class="screen-reader-only" role="status">
  {sending ? i18n.t('timeline.sending') : ''}
</span>
