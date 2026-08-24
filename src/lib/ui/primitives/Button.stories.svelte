<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import type { ComponentProps } from 'svelte';

  import Button from './Button.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Button',
    component: Button,
    tags: ['autodocs'],
    argTypes: {
      variant: {
        control: 'select',
        options: ['primary', 'secondary', 'ghost', 'danger'],
      },
      size: { control: 'select', options: ['small', 'medium', 'large', 'icon'] },
      loading: { control: 'boolean' },
      block: { control: 'boolean' },
      disabled: { control: 'boolean' },
    },
    args: {
      variant: 'primary',
      size: 'medium',
      loading: false,
      block: false,
      disabled: false,
    },
  });

  const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
  const sizes = ['small', 'medium', 'large'] as const;
</script>

{#snippet template(args: ComponentProps<typeof Button>)}
  <Button {...args}>Send message</Button>
{/snippet}

<Story name="Playground" {template} />

<Story name="Variants" asChild>
  <div class="row">
    {#each variants as variant (variant)}
      <Button {variant}>{variant}</Button>
    {/each}
  </div>
</Story>

<Story name="Sizes" asChild>
  <div class="row">
    {#each sizes as size (size)}
      <Button {size}>{size}</Button>
    {/each}
  </div>
</Story>

<Story name="Matrix" asChild>
  <div class="grid">
    {#each variants as variant (variant)}
      {#each sizes as size (size)}
        <Button {variant} {size}>{variant} / {size}</Button>
      {/each}
    {/each}
  </div>
</Story>

<Story name="States" asChild>
  <div class="row">
    <Button>Rest</Button>
    <Button loading>Loading</Button>
    <Button disabled>Disabled</Button>
    <Button block>Block</Button>
  </div>
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .grid {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: repeat(3, max-content);
  }
</style>
