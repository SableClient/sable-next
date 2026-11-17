<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import StarIcon from 'phosphor-svelte/lib/StarIcon';

  import ActionMenu from './ActionMenu.svelte';
  import ActionMenuItem from './ActionMenuItem.svelte';
  import ActionMenuSeparator from './ActionMenuSeparator.svelte';
  import ActionMenuSub from './ActionMenuSub.svelte';
  import Button from './Button.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/ActionMenu',
    component: ActionMenu,
    tags: ['autodocs'],
  });

  const decorative = { 'aria-hidden': 'true' } as const;
  const noop = () => {};
</script>

<Story name="Room options" asChild>
  <div class="pad">
    <ActionMenu label="Room options">
      {#snippet trigger({ props })}
        <Button {...props}>Room options</Button>
      {/snippet}
      <IconContext values={decorative}>
        <ActionMenuItem onSelect={noop}><CheckIcon />Mark as read</ActionMenuItem>
        <ActionMenuItem onSelect={noop}><StarIcon />Favourite</ActionMenuItem>
        <ActionMenuItem onSelect={noop}><LinkIcon />Copy link</ActionMenuItem>
        <ActionMenuSeparator />
        <ActionMenuItem destructive onSelect={noop}><SignOutIcon />Leave room</ActionMenuItem>
      </IconContext>
    </ActionMenu>
  </div>
</Story>

<Story name="Submenu and choices" asChild>
  <div class="pad">
    <ActionMenu label="Room options">
      {#snippet trigger({ props })}
        <Button {...props}>Room options</Button>
      {/snippet}
      <IconContext values={decorative}>
        <ActionMenuSub label="Notifications">
          {#snippet trigger()}<BellIcon />Notifications{/snippet}
          <ActionMenuItem checked onSelect={noop}>All messages</ActionMenuItem>
          <ActionMenuItem checked={false} onSelect={noop}>Mentions and keywords</ActionMenuItem>
          <ActionMenuItem checked={false} onSelect={noop}>Mute</ActionMenuItem>
        </ActionMenuSub>
        <ActionMenuItem disabled onSelect={noop}><LinkIcon />Copy link</ActionMenuItem>
      </IconContext>
    </ActionMenu>
  </div>
</Story>

<style>
  .pad {
    padding-bottom: calc(var(--space-900) * 3.5);
  }
</style>
