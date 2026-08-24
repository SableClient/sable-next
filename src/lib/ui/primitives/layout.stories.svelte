<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';

  import Banner from './Banner.svelte';
  import Button from './Button.svelte';
  import IdentityRow from './IdentityRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import Switch from './Switch.svelte';

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
      <Switch label="Play a sound" checked />
      <Switch label="Show message previews" />
    </SettingsSection>
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 34rem;
  }
</style>
