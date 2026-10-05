<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import SupporterBadge from '#lib/supporter/SupporterBadge.svelte';
  import SupporterBadgePicker from '#lib/supporter/SupporterBadgePicker.svelte';
  import {
    supporterAppearance,
    SUPPORTER_VARIANTS,
    SUPPORTER_SHAPES,
  } from '#lib/supporter/variants.js';

  const { Story } = defineMeta({
    title: 'Supporter/Donor badge',
    component: SupporterBadge,
    tags: ['autodocs'],
    args: {
      label: 'Donor',
      name: 'Alex',
      ...supporterAppearance(),
    },
    argTypes: {
      variant: { control: 'select', options: SUPPORTER_VARIANTS },
      shape: { control: 'select', options: SUPPORTER_SHAPES },
      backgroundColor: { control: 'color' },
      color: { control: 'color' },
      cardColor: { control: 'color' },
      buttonColor: { control: 'color' },
    },
  });
</script>

<script lang="ts">
  let appearance = $state(supporterAppearance());
</script>

<Story name="Playground" />

<Story name="Variants" asChild>
  <div class="row">
    {#each SUPPORTER_VARIANTS as variant (variant)}
      <SupporterBadge label="Donor" name="Alex" {variant} />
    {/each}
  </div>
</Story>

<Story name="Picker" asChild>
  <SupporterBadgePicker
    value={appearance}
    name="Alex"
    onChange={(patch) => {
      appearance = { ...appearance, ...patch };
    }}
  />
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
