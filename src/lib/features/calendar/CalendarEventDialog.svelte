<script lang="ts">
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    type CalendarDraft,
    type CalendarItem,
    type Frequency,
    epochToLocal,
    localToEpoch,
  } from './calendar-events.js';

  const HOUR = 3_600_000;

  interface Props {
    open: boolean;
    item: CalendarItem | null;
    onOpenChange: (open: boolean) => void;
    onSave: (draft: CalendarDraft) => Promise<void>;
  }

  let { open, item, onOpenChange, onSave }: Props = $props();
  const fieldId = $props.id();

  let title = $state('');
  let start = $state('');
  let end = $state('');
  let allDay = $state(false);
  let frequency = $state('');
  let location = $state('');
  let description = $state('');
  let saving = $state(false);
  let failed = $state(false);

  let startAt = $derived(localToEpoch(start, null));
  let endAt = $derived(localToEpoch(end, null));
  let valid = $derived(
    title.trim() !== '' && startAt !== null && endAt !== null && endAt >= startAt
  );

  $effect(() => {
    if (!open) return;
    untrack(() => {
      const from = item ? localToEpoch(item.start, item.timeZone) : null;
      const at = from ?? Math.ceil(Date.now() / HOUR) * HOUR;
      title = item?.title ?? '';
      start = epochToLocal(at).slice(0, 16);
      end = epochToLocal(at + (item ? item.durationMs : HOUR)).slice(0, 16);
      allDay = item?.allDay ?? false;
      frequency = item?.recurrence?.frequency ?? '';
      location = item?.location ?? '';
      description = item?.description ?? '';
      failed = false;
    });
  });

  async function save(): Promise<void> {
    if (!valid || saving || startAt === null || endAt === null) return;
    saving = true;
    failed = false;
    try {
      await onSave({
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        start: startAt,
        end: endAt,
        allDay,
        frequency: frequency === '' ? null : (frequency as Frequency),
      });
      onOpenChange(false);
    } catch (error) {
      console.warn('[sable calendar] saving an event failed', error);
      failed = true;
    } finally {
      saving = false;
    }
  }
</script>

<DialogFrame
  {open}
  {onOpenChange}
  variant="verification"
  label={$i18n.t(item ? 'calendar.editTitle' : 'calendar.newTitle')}
>
  <form
    class="calendar-form"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault();
      void save();
    }}
  >
    <h2>{$i18n.t(item ? 'calendar.editTitle' : 'calendar.newTitle')}</h2>

    <FormField fieldId="{fieldId}-title" label={$i18n.t('calendar.title')}>
      <TextInput id="{fieldId}-title" bind:value={title} maxlength={255} required />
    </FormField>

    <div class="calendar-times">
      <FormField fieldId="{fieldId}-start" label={$i18n.t('calendar.start')}>
        <TextInput id="{fieldId}-start" type="datetime-local" bind:value={start} required />
      </FormField>
      <FormField fieldId="{fieldId}-end" label={$i18n.t('calendar.end')}>
        <TextInput id="{fieldId}-end" type="datetime-local" bind:value={end} required />
      </FormField>
    </div>

    <Switch label={$i18n.t('calendar.allDay')} bind:checked={allDay} />

    <FormField fieldId="{fieldId}-repeat" label={$i18n.t('calendar.repeat')}>
      <Select
        id="{fieldId}-repeat"
        bind:value={frequency}
        items={[
          { value: '', label: $i18n.t('calendar.repeatNever') },
          { value: 'daily', label: $i18n.t('calendar.repeatDaily') },
          { value: 'weekly', label: $i18n.t('calendar.repeatWeekly') },
          { value: 'monthly', label: $i18n.t('calendar.repeatMonthly') },
          { value: 'yearly', label: $i18n.t('calendar.repeatYearly') },
        ]}
      />
    </FormField>

    <FormField fieldId="{fieldId}-location" label={$i18n.t('calendar.location')}>
      <TextInput id="{fieldId}-location" bind:value={location} />
    </FormField>

    <FormField fieldId="{fieldId}-description" label={$i18n.t('calendar.description')}>
      <TextArea id="{fieldId}-description" bind:value={description} />
    </FormField>

    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('errors.actionFailed')}</Alert>
    {/if}

    <DialogActions>
      <Button
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}>{$i18n.t('calendar.cancel')}</Button
      >
      <Button type="submit" loading={saving} disabled={!valid}>{$i18n.t('calendar.save')}</Button>
    </DialogActions>
  </form>
</DialogFrame>

<style>
  .calendar-form {
    display: grid;
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .calendar-times {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }
</style>
