<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { DropdownMenu } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import StarIcon from 'phosphor-svelte/lib/StarIcon';

  import Button from './Button.svelte';
  import './menu.css';

  const { Story } = defineMeta({
    title: 'Primitives/Menu',
    tags: ['autodocs'],
  });

  const decorative = { 'aria-hidden': 'true' } as const;
</script>

<Story name="Surface" asChild>
  <div class="sable-menu demo-menu">
    <IconContext values={decorative}>
      <button class="sable-menu-item" type="button"><StarIcon />Favourite</button>
      <button class="sable-menu-item" type="button"><LinkIcon />Copy link</button>
      <button class="sable-menu-item" type="button"><GearIcon />Settings</button>
      <div class="sable-menu-separator"></div>
      <button class="sable-menu-item sable-menu-item-destructive" type="button">
        <SignOutIcon />Leave room
      </button>
    </IconContext>
  </div>
</Story>

<Story name="Roomy rows" asChild>
  <div class="sable-menu demo-menu">
    <IconContext values={decorative}>
      <button class="sable-menu-item sable-menu-item-roomy" type="button">
        <StarIcon />Favourite
      </button>
      <button class="sable-menu-item sable-menu-item-roomy" type="button">
        <LinkIcon />Copy link
      </button>
      <button class="sable-menu-item sable-menu-item-roomy" type="button">
        <GearIcon />Settings
      </button>
    </IconContext>
  </div>
</Story>

<Story name="States" asChild>
  <div class="sable-menu demo-menu">
    <IconContext values={decorative}>
      <button class="sable-menu-item" type="button"><StarIcon />Rest</button>
      <button class="sable-menu-item" type="button" role="menuitemcheckbox" aria-checked={true}>
        <StarIcon />Checked
      </button>
      <button class="sable-menu-item" type="button" data-highlighted><LinkIcon />Highlighted</button
      >
      <button class="sable-menu-item" type="button" disabled><GearIcon />Disabled</button>
    </IconContext>
  </div>
</Story>

<Story name="Trailing icons" asChild>
  <div class="sable-menu demo-menu demo-sheet">
    <IconContext values={decorative}>
      <button class="sable-menu-item sable-menu-item-trailing-icon" type="button">
        <StarIcon /><span>Favourite</span>
      </button>
      <button class="sable-menu-item sable-menu-item-trailing-icon" type="button">
        <LinkIcon /><span>Copy link</span>
      </button>
      <div class="sable-menu-separator"></div>
      <button
        class="sable-menu-item sable-menu-item-trailing-icon sable-menu-item-destructive"
        type="button"
      >
        <SignOutIcon /><span>Delete message</span>
      </button>
    </IconContext>
  </div>
</Story>

<Story name="Dropdown" asChild>
  <div class="pad">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props}>Room options</Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="sable-menu" sideOffset={4}>
        <IconContext values={decorative}>
          <DropdownMenu.Item class="sable-menu-item"><StarIcon />Favourite</DropdownMenu.Item>
          <DropdownMenu.Item class="sable-menu-item"><LinkIcon />Copy link</DropdownMenu.Item>
          <DropdownMenu.Separator class="sable-menu-separator" />
          <DropdownMenu.Item class="sable-menu-item sable-menu-item-destructive">
            <SignOutIcon />Leave room
          </DropdownMenu.Item>
        </IconContext>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</Story>

<style>
  .demo-menu {
    --menu-min-width: 14rem;

    width: max-content;
  }

  .demo-sheet {
    --menu-item-radius: var(--radii-300);
  }

  .pad {
    padding-bottom: calc(var(--space-900) * 3.5);
  }
</style>
