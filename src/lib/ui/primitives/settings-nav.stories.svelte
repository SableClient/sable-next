<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect, fn } from 'storybook/test';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';
  import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
  import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheckIcon';
  import UserIcon from 'phosphor-svelte/lib/UserIcon';

  import SettingsNav from './SettingsNav.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/SettingsNav',
    component: SettingsNav,
    tags: ['autodocs'],
  });

  const groups = [
    {
      id: 'account',
      label: 'Account',
      entries: [
        { id: 'profile', label: 'Profile', icon: UserIcon },
        { id: 'security', label: 'Security', icon: ShieldCheckIcon },
      ],
    },
    {
      id: 'app',
      label: 'App',
      entries: [
        { id: 'notifications', label: 'Notifications', icon: BellIcon },
        { id: 'appearance', label: 'Appearance', icon: PaletteIcon },
      ],
    },
  ];
</script>

<script lang="ts">
  let activeId = $state<string | null>('profile');
  let largeId = $state<string | null>(null);
</script>

<Story
  name="Playground"
  args={{ groups, activeId: 'profile', ariaLabel: 'Settings', onSelect: fn() }}
  play={async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole('button', { name: 'Profile' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Appearance' }));
    await expect(args.onSelect).toHaveBeenCalledWith(expect.anything(), 'appearance');
  }}
/>

<Story name="Groups" asChild>
  <div class="nav">
    <SettingsNav
      {groups}
      {activeId}
      ariaLabel="Settings"
      onSelect={(_event, id) => (activeId = id)}
    />
  </div>
</Story>

<Story name="Large with chevrons" asChild>
  <div class="nav">
    <SettingsNav
      entries={groups.flatMap((group) => group.entries)}
      activeId={largeId}
      ariaLabel="Settings sections"
      large
      showChevron
      onSelect={(_event, id) => (largeId = id)}
    />
  </div>
</Story>

<style>
  .nav {
    width: 18rem;
  }
</style>
