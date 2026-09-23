<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { presetOffsets, scheduleAt } from './schedule-time.js';

  interface Props {
    open?: boolean;
    empty: boolean;
    encrypted?: boolean | null;
    onSchedule: (dueTs: number) => void;
  }

  let { open = $bindable(false), empty, encrypted = null, onSchedule }: Props = $props();

  const uid = $props.id();
  let date = $state('');
  let time = $state('');
  let timeInput: HTMLInputElement | null = null;

  let chosen = $derived(scheduleAt(date, time, Date.now()));
  let blocked = $derived(encrypted === true && !preferences.scheduleInEncryptedRooms);
  let unavailable = $derived(empty || blocked);

  function reset(): void {
    date = '';
    time = '';
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
    <p class="explain">{$i18n.t('composer.scheduleExplain')}</p>

    {#if empty}
      <Alert variant="warning">{$i18n.t('composer.scheduleEmpty')}</Alert>
    {/if}

    {#if blocked}
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

    <div class="pair">
      <FormField fieldId="{uid}-date" label={$i18n.t('composer.scheduleDate')}>
        <TextInput
          id="{uid}-date"
          type="date"
          bind:value={date}
          onchange={() => timeInput?.focus()}
        />
      </FormField>
      <FormField fieldId="{uid}-time" label={$i18n.t('composer.scheduleTime')}>
        <TextInput
          id="{uid}-time"
          type="time"
          bind:value={time}
          {@attach (node: HTMLInputElement) => {
            timeInput = node;
            return () => {
              timeInput = null;
            };
          }}
        />
      </FormField>
    </div>

    {#if date !== '' && time !== '' && chosen === null}
      <Alert variant="critical" role="alert">{$i18n.t('composer.schedulePast')}</Alert>
    {/if}

    <DialogActions>
      <Button type="button" variant="ghost" onclick={cancel}>
        {$i18n.t('composer.scheduleCancel')}
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

  .pair {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr 1fr;
  }
</style>
