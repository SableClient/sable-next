<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { Dialog } from 'bits-ui';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';

  import Banner from './Banner.svelte';
  import Button from './Button.svelte';
  import DialogFrame from './DialogFrame.svelte';
  import FormField from './FormField.svelte';
  import IdentityRow from './IdentityRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import Switch from './Switch.svelte';
  import TextInput from './TextInput.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Layout',
    tags: ['autodocs'],
  });
</script>

<Story name="Banner" asChild>
  <div class="stack">
    <Banner icon={ShieldWarningIcon} title="Unverified device">
      {#snippet body()}
        <p>Verify this device to read older messages.</p>
      {/snippet}
      {#snippet actions()}
        <Button variant="primary" size="small">Verify</Button>
        <Button variant="ghost" size="small">Later</Button>
      {/snippet}
    </Banner>
    <Banner icon={ShieldWarningIcon} title="Update available" tone="warning">
      {#snippet body()}
        <p>Restart to finish installing the update.</p>
      {/snippet}
      {#snippet actions()}
        <Button variant="primary" size="small">Restart</Button>
      {/snippet}
    </Banner>
  </div>
</Story>

<Story name="Identity row" asChild>
  <div class="stack">
    <IdentityRow displayName="Erwan Leboucher" initials="EL" />
    <IdentityRow displayName="Sable" initials="S" size="medium">
      {#snippet meta()}
        <StatusBadge variant="success" label="Verified" />
      {/snippet}
    </IdentityRow>
    <IdentityRow
      displayName="Someone else"
      initials="SE"
      size="large"
      onclick={() => {}}
      ariaLabel="Open profile"
    />
  </div>
</Story>

<Story name="Settings section" asChild>
  <div class="stack">
    <SettingsSection
      title="Notifications"
      description="Choose what this device tells you about."
      headingId="notifications"
    >
      {#snippet icon()}<BellIcon />{/snippet}
      <ul class="settings-rows">
        <SettingsRow title="Play a sound" icon={BellIcon}
          ><Switch label="Play a sound" checked /></SettingsRow
        >
        <SettingsRow title="Show message previews" icon={BellIcon}
          ><Switch label="Show message previews" /></SettingsRow
        >
      </ul>
    </SettingsSection>
  </div>
</Story>

<Story name="Verification dialog" parameters={{ layout: 'fullscreen' }} asChild>
  <DialogFrame open variant="verification" label="Invite people">
    <div class="dialog-demo">
      <Dialog.Title class="dialog-demo-title">Invite people</Dialog.Title>
      <Dialog.Description class="dialog-demo-description">
        Invite someone to Design Critique by their Matrix ID.
      </Dialog.Description>
      <FormField fieldId="dialog-demo-user" label="Matrix ID">
        <TextInput id="dialog-demo-user" value="@erwan:matrix.org" />
      </FormField>
      <div class="dialog-demo-actions">
        <Button variant="ghost">Cancel</Button>
        <Button>Send invite</Button>
      </div>
    </div>
  </DialogFrame>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 34rem;
  }

  .settings-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  :global(.dialog-demo) {
    display: grid;
    gap: var(--space-400);
    width: min(27rem, calc(100vw - var(--space-700)));
  }

  :global(.dialog-demo-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
  }

  :global(.dialog-demo-description) {
    color: var(--sable-surface-var-on-container);
  }

  :global(.dialog-demo-actions) {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
