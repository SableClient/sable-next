<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import logo from '$lib/assets/res/svg/logo.svg';

  interface Props {
    class?: ClassValue;
  }

  let { class: className = '' }: Props = $props();
</script>

<img class={['sable-brand-mark', className]} src={logo} alt="" />

<style>
  .sable-brand-mark {
    filter: drop-shadow(0 0.375rem 0.625rem var(--sable-shadow));
    height: 4rem;
    width: 4rem;
  }
</style>
