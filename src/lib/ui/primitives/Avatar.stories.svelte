<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import Avatar from './Avatar.svelte';

  const sizes = ['small', 'medium', 'large'] as const;

  const { Story } = defineMeta({
    title: 'Primitives/Avatar',
    component: Avatar,
    tags: ['autodocs'],
    argTypes: { size: { control: 'select', options: sizes } },
    args: { initials: 'EL', alt: 'Erwan Leboucher', size: 'medium' },
  });
</script>

<Story name="Playground" />

<Story name="Sizes" asChild>
  <div class="row">
    {#each sizes as size (size)}
      <Avatar {size} initials="EL" alt="Erwan Leboucher" />
    {/each}
  </div>
</Story>

<Story name="Fallback" asChild>
  <div class="row">
    <Avatar initials="EL" alt="Erwan Leboucher" />
    <Avatar initials="?" alt="Unknown" />
    <Avatar initials="SB" alt="Sable" color="var(--sable-success-container)" />
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
