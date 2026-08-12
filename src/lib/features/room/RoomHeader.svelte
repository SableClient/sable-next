<script lang="ts">
  import { i18n } from '$lib/i18n';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersThreeIcon';

  interface Props {
    roomName: string;
    onBack: () => void;
    onMembers: () => void;
    initials: (name: string) => string;
  }

  let { roomName, onBack, onMembers, initials }: Props = $props();
</script>

<header class="room-header">
  <button type="button" class="back-button" aria-label={$i18n.t('timeline.back')} onclick={onBack}>
    <BackIcon />
  </button>
  <span class="room-avatar" aria-hidden="true">{initials(roomName)}</span>
  <h1>{roomName}</h1>
  <button
    type="button"
    class="members-button"
    aria-label={$i18n.t('timeline.members')}
    onclick={onMembers}
  >
    <UsersIcon />
    <span>{$i18n.t('timeline.members')}</span>
  </button>
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
    padding: 0 1rem;
  }

  .room-header h1 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-avatar {
    align-items: center;
    background: var(--sable-primary-main);
    border-radius: 50%;
    color: var(--sable-primary-on-main);
    display: flex;
    flex: 0 0 2.25rem;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 2.25rem;
    justify-content: center;
    width: 2.25rem;
  }

  .back-button,
  .members-button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 0.375rem;
    justify-content: center;
    min-height: 2rem;
    padding: 0 0.5rem;
  }

  .back-button {
    display: none;
    height: 2.25rem;
    padding: 0;
    width: 2.25rem;
  }

  .members-button {
    margin-left: auto;
  }

  .back-button:hover,
  .back-button:focus-visible,
  .members-button:hover,
  .members-button:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .back-button :global(svg),
  .members-button :global(svg) {
    height: 1.25rem;
    width: 1.25rem;
  }

  @media (width < 48rem) {
    .back-button {
      display: flex;
    }

    .room-avatar,
    .members-button span {
      display: none;
    }
  }
</style>
