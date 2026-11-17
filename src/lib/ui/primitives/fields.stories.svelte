<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import IconContext from 'phosphor-svelte/lib/IconContext';

  import Combobox from './Combobox.svelte';
  import DateTimeField from './DateTimeField.svelte';
  import FormField from './FormField.svelte';
  import SaveBar from './SaveBar.svelte';
  import SearchField from './SearchField.svelte';
  import Switcher from './Switcher.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Fields',
    tags: ['autodocs'],
  });

  const homeservers = [
    { value: 'matrix.org', label: 'matrix.org' },
    { value: 'sable.moe', label: 'sable.moe' },
    { value: 'mozilla.org', label: 'mozilla.org' },
    { value: 'kde.org', label: 'kde.org' },
  ];

  const themes = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const decorative = { 'aria-hidden': 'true' } as const;
  const noop = () => {};
</script>

<script lang="ts">
  let query = $state('');
  let homeserver = $state('');
  let startsAt = $state('2026-12-31T17:05');
  let theme = $state('system');
</script>

<Story name="Search field" asChild>
  <div class="stack">
    <SearchField label="Search rooms" bind:value={query} />
  </div>
</Story>

<Story name="Combobox" asChild>
  <IconContext values={decorative}>
    <div class="stack">
      <FormField fieldId="fields-homeserver" label="Homeserver">
        <Combobox
          id="fields-homeserver"
          items={homeservers}
          bind:value={homeserver}
          placeholder="matrix.org"
        />
      </FormField>
    </div>
  </IconContext>
</Story>

<Story name="Date and time" asChild>
  <div class="stack">
    <DateTimeField label="Event starts" bind:value={startsAt} />
    <DateTimeField label="Event date" granularity="day" value="2026-12-31T00:00" />
  </div>
</Story>

<Story name="Switcher" asChild>
  <div class="stack">
    <Switcher label="Theme" items={themes} bind:value={theme} />
    <Switcher label="Theme (disabled)" items={themes} value="dark" disabled />
  </div>
</Story>

<Story name="Save bar" asChild>
  <div class="stack">
    <SaveBar
      dirty={false}
      saving={false}
      saved={false}
      failed={false}
      onReset={noop}
      onSave={noop}
    />
    <SaveBar dirty saving={false} saved={false} failed={false} onReset={noop} onSave={noop} />
    <SaveBar dirty saving saved={false} failed={false} onReset={noop} onSave={noop} />
    <SaveBar dirty={false} saving={false} saved failed={false} onReset={noop} onSave={noop} />
    <SaveBar dirty saving={false} saved={false} failed onReset={noop} onSave={noop} />
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 26rem;
    padding-bottom: calc(var(--space-900) * 2);
  }
</style>
