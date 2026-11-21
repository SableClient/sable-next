<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect, fn } from 'storybook/test';

  import '#lib/features/auth/shared/auth-card.css';
  import SetupActions from './SetupActions.svelte';

  const { Story } = defineMeta({
    title: 'Auth/SetupActions',
    component: SetupActions,
    tags: ['autodocs'],
    args: { skip: { onclick: fn() }, onLogout: fn(), loggingOut: false, logoutFailed: false },
  });
</script>

{#snippet template(args: import('svelte').ComponentProps<typeof SetupActions>)}
  <div class="auth-page frame">
    <SetupActions {...args} />
  </div>
{/snippet}

<Story
  name="Skip and log out"
  {template}
  play={async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Skip for now' }));
    await expect(args.skip?.onclick).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Log out' }));
    await expect(args.onLogout).toHaveBeenCalledOnce();
  }}
/>

<Story name="Log out only" {template} args={{ skip: null }} />

<Story name="Skip disabled" {template} args={{ skip: { onclick: fn(), disabled: true } }} />

<Story name="Logging out" {template} args={{ loggingOut: true }} />

<Story
  name="Log out failed"
  {template}
  args={{ logoutFailed: true }}
  play={async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toBeVisible();
  }}
/>

<style>
  .frame {
    background: var(--bg-container);
    max-width: 24rem;
    padding: var(--space-400);
  }
</style>
