<script lang="ts">
  import JoinAddressForm from '#lib/features/room/JoinAddressForm.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
</script>

<AppPageShell title={$i18n.t('room.joinTitle')} description={$i18n.t('room.joinDescription')}>
  <JoinAddressForm />
</AppPageShell>
