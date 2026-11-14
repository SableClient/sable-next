<script lang="ts">
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';

  import { openFindOrJoin } from '#lib/ui/find-or-join-state.svelte.js';
  import RoomDirectory from '#lib/features/room/discovery/RoomDirectory.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
</script>

<AppPageShell
  title={i18n.t('room.directoryTitle')}
  description={i18n.t('room.directoryDescription')}
>
  <div>
    <Button variant="secondary" onclick={() => openFindOrJoin()}>
      <LinkIcon aria-hidden="true" />
      {i18n.t('nav.findOrJoin')}
    </Button>
  </div>

  <RoomDirectory />
</AppPageShell>
