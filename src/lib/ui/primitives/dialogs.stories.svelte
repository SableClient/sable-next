<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { Dialog } from 'bits-ui';

  import Button from './Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import DialogActions from './DialogActions.svelte';
  import ResponsiveDialog from './ResponsiveDialog.svelte';
  import ResponsiveInfoDialog from './ResponsiveInfoDialog.svelte';
  import ResponsivePopover from './ResponsivePopover.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Dialogs',
    tags: ['autodocs'],
  });
</script>

<script lang="ts">
  let confirmOpen = $state(false);
  let busyOpen = $state(false);
  let failedOpen = $state(false);
  let responsiveOpen = $state(false);
  let infoOpen = $state(false);
  let popoverOpen = $state(false);
</script>

<Story name="Confirm dialog" asChild>
  <Button onclick={() => (confirmOpen = true)}>Leave room</Button>
  <ConfirmDialog
    bind:open={confirmOpen}
    title="Leave Design Critique?"
    description="You will stop receiving messages from this room."
    confirmLabel="Leave"
    onConfirm={() => (confirmOpen = false)}
  />
</Story>

<Story name="Confirm dialog: busy" asChild>
  <Button onclick={() => (busyOpen = true)}>Delete message</Button>
  <ConfirmDialog
    bind:open={busyOpen}
    title="Delete this message?"
    description="Everyone in the room will stop seeing it."
    confirmLabel="Delete"
    busy
  />
</Story>

<Story name="Confirm dialog: error" asChild>
  <Button onclick={() => (failedOpen = true)}>Sign out</Button>
  <ConfirmDialog
    bind:open={failedOpen}
    title="Sign out of this device?"
    confirmLabel="Sign out"
    confirmVariant="primary"
    error="Could not reach the homeserver. Check your connection and try again."
  />
</Story>

<Story name="Responsive dialog" asChild>
  <Button onclick={() => (responsiveOpen = true)}>Invite people</Button>
  <ResponsiveDialog bind:open={responsiveOpen} label="Invite people" closeLabel="Close">
    <div class="demo">
      <Dialog.Title class="demo-title">Invite people</Dialog.Title>
      <Dialog.Description>Invite someone to Design Critique by their Matrix ID.</Dialog.Description>
      <DialogActions>
        <Button variant="ghost" onclick={() => (responsiveOpen = false)}>Cancel</Button>
        <Button variant="primary" onclick={() => (responsiveOpen = false)}>Send invite</Button>
      </DialogActions>
    </div>
  </ResponsiveDialog>
</Story>

<Story name="Responsive info dialog" asChild>
  <Button onclick={() => (infoOpen = true)}>About encryption</Button>
  <ResponsiveInfoDialog bind:open={infoOpen} label="About encryption" closeLabel="Close">
    {#snippet header()}
      <Dialog.Title class="demo-title">About encryption</Dialog.Title>
    {/snippet}
    {#snippet body()}
      <div class="demo">
        <p>Messages in this room are end-to-end encrypted. Only its members can read them.</p>
      </div>
    {/snippet}
  </ResponsiveInfoDialog>
</Story>

<Story name="Responsive popover" asChild>
  <div class="pad">
    <ResponsivePopover bind:open={popoverOpen} label="Room topic" closeLabel="Close" side="bottom">
      {#snippet trigger({ props })}
        <Button {...props}>Room topic</Button>
      {/snippet}
      <div class="demo popover">
        <p>Design reviews, mockups and weekly critique notes.</p>
      </div>
    </ResponsivePopover>
  </div>
</Story>

<style>
  .demo {
    display: grid;
    gap: var(--space-400);
    width: min(27rem, calc(100vw - var(--space-700)));
  }

  .popover {
    padding: var(--space-400);
  }

  .pad {
    padding-bottom: calc(var(--space-900) * 2);
  }

  :global(.demo-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
  }
</style>
