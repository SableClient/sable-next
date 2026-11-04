<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import type { RuntimeConfig } from '#lib/config/runtime-config.js';
  import { logoUrl } from '#lib/deployment/brand.js';
  import logo from '#lib/assets/res/svg/logo.svg';

  interface Props {
    class?: ClassValue;
    config?: RuntimeConfig;
  }

  let { class: className = '', config }: Props = $props();
</script>

<img class={['brand-mark', className]} src={logoUrl(config) ?? logo} alt="" />

<style>
  .brand-mark {
    filter: drop-shadow(0 0.375rem 0.625rem var(--shadow-color));
    height: 4rem;
    width: 4rem;
  }
</style>
