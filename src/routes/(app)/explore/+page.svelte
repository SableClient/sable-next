<script lang="ts">
  import JoinAddressForm from '#lib/features/room/JoinAddressForm.svelte';
  import RoomDirectory from '#lib/features/room/RoomDirectory.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
</script>

<AppPageShell
  title={$i18n.t('room.directoryTitle')}
  description={$i18n.t('room.directoryDescription')}
>
  <RoomDirectory />

  <SettingsSection
    headingId="explore-join-by-address"
    title={$i18n.t('room.directoryJoinByAddress')}
    description={$i18n.t('room.joinDescription')}
  >
    <JoinAddressForm />
  </SettingsSection>
</AppPageShell>
