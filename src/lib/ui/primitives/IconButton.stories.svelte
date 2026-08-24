<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import type { ComponentProps } from 'svelte';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import IconButton from './IconButton.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/IconButton',
    component: IconButton,
    tags: ['autodocs'],
    argTypes: {
      variant: {
        control: 'select',
        options: ['primary', 'secondary', 'ghost', 'danger'],
      },
      size: { control: 'select', options: ['small', 'medium', 'large'] },
      disabled: { control: 'boolean' },
    },
    args: { label: 'Settings', variant: 'ghost', size: 'medium', disabled: false },
  });

  const sizes = ['small', 'medium', 'large'] as const;
</script>

{#snippet template(args: ComponentProps<typeof IconButton>)}
  <IconButton {...args} label="Settings"><GearIcon /></IconButton>
{/snippet}

<Story name="Playground" {template} />

<Story name="Sizes" asChild>
  <div class="row">
    {#each sizes as size (size)}
      <IconButton {size} label="Settings"><GearIcon /></IconButton>
    {/each}
  </div>
</Story>

<Story name="Variants" asChild>
  <div class="row">
    <IconButton variant="primary" label="Send"><PaperPlaneTiltIcon /></IconButton>
    <IconButton variant="secondary" label="Settings"><GearIcon /></IconButton>
    <IconButton variant="ghost" label="Settings"><GearIcon /></IconButton>
    <IconButton variant="danger" label="Delete"><TrashIcon /></IconButton>
  </div>
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
