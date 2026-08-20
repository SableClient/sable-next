<script lang="ts">
  import CreateRoomForm from '#lib/features/room/CreateRoomForm.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
</script>

<AppPageShell title={$i18n.t('room.createTitle')} description={$i18n.t('room.createDescription')}>
  <CreateRoomForm />
</AppPageShell>
