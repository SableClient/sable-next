<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DateTimeField from '#lib/ui/primitives/DateTimeField.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { presetOffsets, scheduleAt, scheduleInputs } from './schedule-time.js';

  interface Props {
    open?: boolean;
    empty: boolean;
    attachmentsBlocked?: boolean;
    encrypted?: boolean | null;
    dueTs?: number | null;
    onSchedule: (dueTs: number) => void;
  }

  let {
    open = $bindable(false),
    empty,
    attachmentsBlocked = false,
    encrypted = null,
    dueTs = null,
    onSchedule,
  }: Props = $props();

  let moment = $derived(momentOf(dueTs));

  let chosen = $derived(scheduleAt(moment.slice(0, 10), moment.slice(11, 16), Date.now()));
  let blocked = $derived(encrypted === true && !preferences.scheduleInEncryptedRooms);
  let unavailable = $derived(empty || blocked || attachmentsBlocked);

  function momentOf(ts: number | null): string {
    const { date, time } = scheduleInputs(ts);
    return date === '' ? '' : `${date}T${time}`;
  }

  function reset(): void {
    moment = momentOf(dueTs);
  }

  function confirm(dueTs: number): void {
    open = false;
    reset();
    onSchedule(dueTs);
  }

  function cancel(): void {
    open = false;
    reset();
  }

  function submit(): void {
    if (!unavailable && chosen !== null) confirm(chosen);
  }
</script>

<DialogFrame
  bind:open
  variant="verification"
  label={$i18n.t('composer.scheduleTitle')}
  onConfirm={submit}
>
  <div class="schedule">
    <h2>{$i18n.t('composer.scheduleTitle')}</h2>
    {#if encrypted !== true}
      <p class="explain">{$i18n.t('composer.scheduleExplain')}</p>
    {/if}

    {#if empty}
      <Alert variant="warning">{$i18n.t('composer.scheduleEmpty')}</Alert>
    {/if}

    {#if attachmentsBlocked}
      <Alert variant="warning">{$i18n.t('composer.scheduleAttachmentEncrypted')}</Alert>
    {:else if blocked}
      <Alert variant="warning">{$i18n.t('composer.scheduleEncryptedBlocked')}</Alert>
    {:else if encrypted === true}
      <Alert>{$i18n.t('composer.scheduleEncryptedNote')}</Alert>
    {/if}

    <div class="presets">
      {#each presetOffsets as preset (preset.key)}
        <Button
          variant="ghost"
          disabled={unavailable}
          onclick={() => {
            confirm(preset.at(Date.now()));
          }}
        >
          {$i18n.t(`composer.schedule${preset.key}`)}
        </Button>
      {/each}
    </div>

    <DateTimeField label={$i18n.t('common.dateAndTime')} bind:value={moment} />

    {#if moment !== '' && chosen === null}
      <Alert variant="critical" role="alert">{$i18n.t('composer.schedulePast')}</Alert>
    {/if}

    <DialogActions>
      <Button type="button" variant="ghost" onclick={cancel}>
        {$i18n.t('common.cancel')}
      </Button>
      <Button type="submit" disabled={unavailable || chosen === null}>
        {$i18n.t('composer.scheduleConfirm')}
      </Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .schedule {
    display: grid;
    gap: var(--space-400);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
