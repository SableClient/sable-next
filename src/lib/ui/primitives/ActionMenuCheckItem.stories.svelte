<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect, screen, within } from 'storybook/test';

  import ActionMenu from './ActionMenu.svelte';
  import ActionMenuCheckItem from './ActionMenuCheckItem.svelte';
  import Button from './Button.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/ActionMenuCheckItem',
    component: ActionMenuCheckItem,
    tags: ['autodocs'],
  });

  const noop = () => {};
</script>

<Story
  name="Checked and unchecked"
  asChild
  play={async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'View options' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemcheckbox');
    await expect(items).toHaveLength(2);
    await expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await expect(items[1]).toHaveAttribute('aria-checked', 'false');
  }}
>
  <div class="pad">
    <ActionMenu label="View options">
      {#snippet trigger({ props })}
        <Button {...props}>View options</Button>
      {/snippet}
      <ActionMenuCheckItem kind="checkbox" checked label="Group favourites" onSelect={noop} />
      <ActionMenuCheckItem
        kind="checkbox"
        checked={false}
        label="Show unread counts"
        onSelect={noop}
      />
    </ActionMenu>
  </div>
</Story>

<Story
  name="Single choice"
  asChild
  play={async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Sort rooms' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    await expect(items).toHaveLength(2);
    await expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await expect(items[1]).toHaveAttribute('aria-checked', 'false');
  }}
>
  <div class="pad">
    <ActionMenu label="Sort rooms">
      {#snippet trigger({ props })}
        <Button {...props}>Sort rooms</Button>
      {/snippet}
      <ActionMenuCheckItem checked label="Recent activity" onSelect={noop} />
      <ActionMenuCheckItem checked={false} label="Alphabetical" onSelect={noop} />
    </ActionMenu>
  </div>
</Story>

<style>
  .pad {
    padding-bottom: calc(var(--space-900) * 3.5);
  }
</style>
