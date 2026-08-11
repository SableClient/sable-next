<script lang="ts">
  import { Label as BitsLabel, type WithoutChildrenOrChild } from 'bits-ui';
  import type { Snippet } from 'svelte';

  type Props = WithoutChildrenOrChild<BitsLabel.RootProps> & {
    children?: Snippet;
  };

  let { children, ...rest }: Props = $props();
</script>

<BitsLabel.Root {...rest}>
  {#snippet child({ props })}
    <label {...props} class="label">
      {@render children?.()}
    </label>
  {/snippet}
</BitsLabel.Root>

<style>
  .label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }
</style>
