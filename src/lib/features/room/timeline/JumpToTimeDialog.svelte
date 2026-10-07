<script lang="ts">
  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { scheduleInputs } from '#lib/features/composer/schedule-time.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DateTimeField from '#lib/ui/primitives/DateTimeField.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    open: boolean;
    roomId: string;
    onOpenChange: (open: boolean) => void;
    onJump: (eventId: string) => void;
  }

  let { open, roomId, onOpenChange, onJump }: Props = $props();
  const core = useCoreClient();

  let value = $state('');
  let searching = $state(false);
  let outcome = $state<'missing' | 'failed' | null>(null);

  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      value = localInput(Date.now());
      outcome = null;
    });
  });

  function localInput(timestamp: number): string {
    const { date, time } = scheduleInputs(timestamp);
    return `${date}T${time}`;
  }

  function startOfDay(daysAgo: number): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  }

  function setDay(daysAgo: number): void {
    value = localInput(startOfDay(daysAgo));
    outcome = null;
  }

  async function jump(): Promise<void> {
    const at = value === '' ? Number.NaN : new Date(value).getTime();
    if (Number.isNaN(at) || searching) return;

    searching = true;
    outcome = null;
    try {
      const eventId = await core.commands.timestampToEvent(roomId, at, 'forward');
      if (eventId === null) {
        outcome = 'missing';
        return;
      }
      onOpenChange(false);
      onJump(eventId);
    } catch (error) {
      console.warn('[sable room] jump to time failed', error);
      outcome = 'failed';
    } finally {
      searching = false;
    }
  }
</script>

<DialogFrame
  {open}
  {onOpenChange}
  variant="verification"
  label={$i18n.t('room.menuJumpToTime')}
  onConfirm={() => void jump()}
>
  <div class="jump">
    <h2>{$i18n.t('room.menuJumpToTime')}</h2>
    <p class="explain">{$i18n.t('room.jumpBody')}</p>

    <DateTimeField label={$i18n.t('common.dateAndTime')} bind:value />

    <div class="shortcuts">
      <Button
        size="small"
        variant="secondary"
        onclick={() => {
          setDay(0);
        }}>{$i18n.t('common.today')}</Button
      >
      <Button
        size="small"
        variant="secondary"
        onclick={() => {
          setDay(1);
        }}>{$i18n.t('common.yesterday')}</Button
      >
      <Button
        size="small"
        variant="secondary"
        onclick={() => {
          setDay(7);
        }}>{$i18n.t('room.jumpLastWeek')}</Button
      >
    </div>

    {#if outcome === 'missing'}
      <Alert variant="info" role="status">{$i18n.t('room.jumpMissing')}</Alert>
    {:else if outcome === 'failed'}
      <Alert variant="critical" role="alert">{$i18n.t('room.jumpFailed')}</Alert>
    {/if}

    <DialogActions>
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}>{$i18n.t('common.cancel')}</Button
      >
      <Button type="submit" loading={searching}>{$i18n.t('room.jumpSubmit')}</Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .jump {
    display: grid;
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }
</style>
