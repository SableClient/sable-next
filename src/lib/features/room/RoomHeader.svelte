<script lang="ts">
  import { i18n } from '$lib/i18n';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersThreeIcon';

  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';

  interface Props {
    roomName: string;
    onBack: () => void;
    onMembers: () => void;
    initials: (name: string) => string;
  }

  let { roomName, onBack, onMembers, initials }: Props = $props();
</script>

<header class="room-header">
  <IconButton
    class="back-button"
    variant="ghost"
    size="small"
    label={$i18n.t('timeline.back')}
    onclick={onBack}
  >
    <BackIcon />
  </IconButton>
  <Avatar class="room-avatar" initials={initials(roomName)} size="small" />
  <h1>{roomName}</h1>
  <Button class="members-button" variant="ghost" size="small" onclick={onMembers}>
    <UsersIcon />
    <span>{$i18n.t('timeline.members')}</span>
  </Button>
</header>

<style>
  .room-header {
    align-items: center;
    background: var(--sable-bg-container);
    border-bottom: 1px solid var(--sable-surface-var-container);
    display: flex;
    flex: 0 0 auto;
    gap: 0.625rem;
    min-height: 3.75rem;
    padding: 0 var(--page-gutter);
  }

  .room-header h1 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.sable-avatar.room-avatar) {
    background: var(--sable-primary-main);
    color: var(--sable-primary-on-main);
  }

  :global(.back-button),
  :global(.members-button) {
    gap: 0.375rem;
  }

  :global(.back-button) {
    display: none;
  }

  :global(.members-button) {
    margin-left: auto;
  }

  :global(.back-button svg),
  :global(.members-button svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  @media (width < 48rem) {
    :global(.back-button) {
      display: inline-flex;
    }

    :global(.sable-avatar.room-avatar),
    :global(.members-button span) {
      display: none;
    }
  }
</style>
