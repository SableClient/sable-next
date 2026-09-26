<script lang="ts">
  import { type DateValue, parseDateTime } from '@internationalized/date';
  import { DateField } from 'bits-ui';
  import './form-control.css';

  import { currentLocale } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  interface Props {
    label: string;
    value?: string;
    granularity?: 'day' | 'minute';
    required?: boolean;
  }

  let { label, value = $bindable(''), granularity = 'minute', required = false }: Props = $props();

  const FORMAT_LOCALES = { dmy: 'en-GB', mdy: 'en-US', ymd: 'sv-SE' } as const;

  let appLocale = $derived(currentLocale());
  let hourCycle = $derived<12 | 24>(
    preferences.hour24Clock ||
      !['h11', 'h12'].includes(
        new Intl.DateTimeFormat(appLocale, { hour: 'numeric' }).resolvedOptions().hourCycle ?? ''
      )
      ? 24
      : 12
  );
  let locale = $derived(
    `${preferences.dateFormat === 'auto' ? appLocale : FORMAT_LOCALES[preferences.dateFormat]}-u-hc-${hourCycle === 24 ? 'h23' : 'h12'}`
  );
  let parsed = $derived.by(() => {
    try {
      return value === '' ? undefined : parseDateTime(value);
    } catch {
      return undefined;
    }
  });
</script>

<DateField.Root
  value={parsed}
  onValueChange={(next: DateValue | undefined) => {
    value = next ? next.toString() : '';
  }}
  {granularity}
  {locale}
  {hourCycle}
  {required}
>
  <div class="date-time-field">
    <DateField.Label class="date-time-field-label">{label}</DateField.Label>
    <DateField.Input
      class="form-control date-time-field-input"
      onkeydown={(event: KeyboardEvent) => {
        if (event.key !== 'Enter' || !(event.target instanceof HTMLElement)) return;
        event.preventDefault();
        event.target.closest('form')?.requestSubmit();
      }}
    >
      {#snippet children({ segments })}
        {#each segments as { part, value: text }, index (`${part}-${String(index)}`)}
          <DateField.Segment {part} class="date-time-field-segment">{text}</DateField.Segment>
        {/each}
      {/snippet}
    </DateField.Input>
  </div>
</DateField.Root>

<style>
  .date-time-field {
    display: grid;
    gap: var(--space-200);
  }

  :global(.date-time-field-label) {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }

  :global(.date-time-field-input) {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    width: 100%;
  }

  :global(.date-time-field-input:focus-within) {
    --form-control-line: var(--primary-main);
    --form-control-ring: var(--border-width-600);
  }

  :global(.date-time-field-segment) {
    border-radius: var(--radius-inner);
    font-variant-numeric: tabular-nums;
  }

  :global(.date-time-field-segment:focus) {
    background: var(--primary-main);
    color: var(--primary-on-main);
    outline: none;
  }

  :global(.date-time-field-segment[data-segment='literal']) {
    color: var(--surface-var-on-container);
  }
</style>
