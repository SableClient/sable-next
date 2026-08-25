<script lang="ts">
  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

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
    const at = new Date(timestamp);
    const pad = (part: number, width = 2): string => String(part).padStart(width, '0');
    const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
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
    const at = Date.parse(value);
    if (Number.isNaN(at) || searching) return;

    searching = true;
    outcome = null;
    try {
      const eventId = await core.timestampToEvent(roomId, at, 'forward');
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

<DialogFrame {open} {onOpenChange} variant="verification" label={$i18n.t('room.jumpTitle')}>
  <div class="jump">
    <h2>{$i18n.t('room.jumpTitle')}</h2>
    <p class="explain">{$i18n.t('room.jumpBody')}</p>

    <div class="field">
      <Label for="room-jump-at">{$i18n.t('room.jumpMoment')}</Label>
      <TextInput
        id="room-jump-at"
        type="datetime-local"
        bind:value
        onkeydown={(event: KeyboardEvent) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void jump();
        }}
      />
    </div>

    <div class="shortcuts">
      <Button
        size="small"
        variant="secondary"
        onclick={() => {
          setDay(0);
        }}>{$i18n.t('room.jumpToday')}</Button
      >
      <Button
        size="small"
        variant="secondary"
        onclick={() => {
          setDay(1);
        }}>{$i18n.t('room.jumpYesterday')}</Button
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

    <div class="actions">
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}>{$i18n.t('room.jumpCancel')}</Button
      >
      <Button
        loading={searching}
        onclick={() => {
          void jump();
        }}>{$i18n.t('room.jumpSubmit')}</Button
      >
    </div>
  </div>
</DialogFrame>

<style>
  .jump {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
