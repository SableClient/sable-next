<script lang="ts">
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    roomName: string;
    roomAvatar: string | null;
    onBack: () => void;
    onSearch: () => void;
  }

  let { roomName, roomAvatar, onBack, onSearch }: Props = $props();
</script>

<header class="forum-header">
  <IconButton
    class="back-button"
    variant="ghost"
    size="small"
    label={$i18n.t('timeline.back')}
    onclick={onBack}
  >
    <BackIcon />
  </IconButton>
  <Avatar class="forum-avatar" src={roomAvatar} name={roomName} size="small" />
  <h1>{roomName}</h1>
  <IconButton
    class="search-button"
    variant="ghost"
    size="small"
    label={$i18n.t('search.open')}
    onclick={onSearch}
  >
    <MagnifyingGlassIcon />
  </IconButton>
</header>

<style>
  .forum-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .forum-header h1 {
    flex: 1;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
