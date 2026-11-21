<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect, fn } from 'storybook/test';

  import SetupRailPreview from './SetupRailPreview.svelte';

  const { Story } = defineMeta({
    title: 'Auth/Setup rail',
    component: SetupRailPreview,
    tags: ['autodocs'],
    parameters: { layout: 'fullscreen' },
    argTypes: {
      step: {
        control: 'select',
        options: [
          'device',
          'recovery',
          'profile',
          'notifications',
          'appearance',
          'layout',
          'sync',
          'consent',
          'done',
        ],
      },
    },
    args: { step: 'device', onLogout: fn() },
  });
</script>

<Story
  name="Confirm device"
  play={async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Skip for now' }));
    await expect(await canvas.findByRole('button', { name: 'Skip anyway' })).toBeVisible();
  }}
/>

<Story name="Recovery key" args={{ step: 'recovery' }} />

<Story name="Profile" args={{ step: 'profile' }} />

<Story name="Notifications" args={{ step: 'notifications' }} />

<Story name="Appearance" args={{ step: 'appearance' }} />

<Story name="Chat layout" args={{ step: 'layout' }} />

<Story
  name="Settings sync"
  args={{ step: 'sync' }}
  play={async ({ canvas }) => {
    await expect(
      await canvas.findByRole('button', { name: /^(Use synced settings|Turn on sync)$/ })
    ).toBeEnabled();
  }}
/>

<Story name="Error reporting" args={{ step: 'consent' }} />

<Story name="Done" args={{ step: 'done' }} />
