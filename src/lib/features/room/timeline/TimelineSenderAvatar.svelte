<script lang="ts">
  import '../members/avatar-button.css';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    src: string | null;
    id: string | null;
    name: string;
    size: 'tiny' | 'small';
    onOpenProfile?: (anchor: HTMLElement) => void;
  }

  let { src, id, name, size, onOpenProfile }: Props = $props();
</script>

{#snippet avatar()}
  <Avatar class="message-avatar" {src} {size} {id} {name} />
{/snippet}
{#if onOpenProfile}
  <button
    class="sender-avatar-button"
    type="button"
    aria-label={i18n.t('timeline.senderProfile', { name })}
    onclick={(event) => {
      onOpenProfile(event.currentTarget);
    }}
  >
    {@render avatar()}
  </button>
{:else}
  {@render avatar()}
{/if}
