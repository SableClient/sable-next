<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import StatusBadge from './StatusBadge.svelte';

  const variants = ['neutral', 'secondary', 'primary', 'success', 'warning', 'critical'] as const;

  const { Story } = defineMeta({
    title: 'Primitives/StatusBadge',
    component: StatusBadge,
    tags: ['autodocs'],
    argTypes: { variant: { control: 'select', options: variants } },
    args: { label: 'Verified', variant: 'neutral' },
  });
</script>

<Story name="Playground" />

<Story name="Variants" asChild>
  <div class="row">
    {#each variants as variant (variant)}
      <StatusBadge {variant} label={variant} />
    {/each}
  </div>
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }
</style>
