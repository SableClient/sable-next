<script lang="ts">
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';

  interface Props {
    offset: number;
    armed: boolean;
    edit?: boolean;
    members?: boolean;
  }

  let { offset, armed, edit = false, members = false }: Props = $props();
</script>

<div
  class={['swipe-action', { armed }]}
  aria-hidden="true"
  style:width={`${String(offset)}px`}
  style:transform={`translateX(calc(${String(offset)}px * var(--inline-sign)))`}
>
  {#if edit}
    <PencilSimpleIcon weight="bold" />
  {:else if members}
    <UsersIcon weight="bold" />
  {:else}
    <ReplyIcon weight="bold" />
  {/if}
</div>

<style>
  .swipe-action {
    align-items: center;
    bottom: 0;
    color: var(--sec-main);
    display: flex;
    inset-inline-end: 0;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    position: absolute;
    top: 0;
  }

  .swipe-action.armed {
    color: var(--primary-main);
  }
</style>
