<script lang="ts">
  import type { GroupMemberView } from '#src/generated/protocol';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  let { members }: { members: GroupMemberView[] } = $props();
</script>

<span class="group-avatar" data-count={members.length}>
  {#each members as member (member.user_id)}
    <Avatar
      size="tiny"
      id={member.user_id}
      src={member.avatar_url}
      name={member.name ?? member.user_id}
      uniform
    />
  {/each}
</span>

<style>
  .group-avatar {
    flex: none;
    height: var(--group-avatar-size, 1.5rem);
    position: relative;
    width: var(--group-avatar-size, 1.5rem);
  }

  .group-avatar :global(.avatar-root) {
    --avatar-size: calc(var(--group-avatar-size, 1.5rem) * 0.58);

    border-radius: 50%;
    font-size: calc(var(--avatar-size) * 0.5);
    position: absolute;
  }

  .group-avatar :global(.avatar-root:nth-child(1)) {
    inset-block-start: 0;
    inset-inline-start: calc((100% - var(--avatar-size)) / 2);
  }

  .group-avatar :global(.avatar-root:nth-child(2)) {
    inset-block-end: 0;
    inset-inline-start: 0;
  }

  .group-avatar :global(.avatar-root:nth-child(3)) {
    inset-block-end: 0;
    inset-inline-end: 0;
  }

  /* Two faces have room to be larger than three. */
  .group-avatar[data-count='2'] :global(.avatar-root) {
    --avatar-size: calc(var(--group-avatar-size, 1.5rem) * 0.68);
  }

  .group-avatar[data-count='2'] :global(.avatar-root:nth-child(1)) {
    inset-inline-start: 0;
  }

  .group-avatar[data-count='2'] :global(.avatar-root:nth-child(2)) {
    inset-inline: auto 0;
  }
</style>
