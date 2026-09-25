<script lang="ts">
  import MediaImage from '#lib/ui/MediaImage.svelte';

  interface Props {
    icon: string;
    class?: string;
  }

  let { icon, class: className = '' }: Props = $props();
</script>

{#if icon.startsWith('mxc://')}
  <MediaImage source={icon} alt="" width={24} height={24} class={`role-tag-icon ${className}`} />
{:else}
  <span class={['role-tag-icon', className]} aria-hidden="true">{icon}</span>
{/if}

<style>
  .role-tag-icon {
    display: inline-flex;
    flex: 0 0 auto;
    height: 1em;
    line-height: 1;
    width: 1em;
  }

  :global(.role-tag-icon.media-image) {
    block-size: 1em;
    display: inline-flex;
    inline-size: 1em;
  }
</style>
