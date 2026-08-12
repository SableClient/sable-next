<script lang="ts">
  import { Button as BitsButton } from 'bits-ui';

  import Spinner from './Spinner.svelte';
  import type { ButtonProps } from './button-types';
  import './button.css';

  let {
    type = 'button',
    disabled = false,
    variant = 'secondary',
    size = 'medium',
    loading = false,
    class: className = '',
    children,
    ...rest
  }: ButtonProps = $props();
</script>

<BitsButton.Root
  {...rest}
  {type}
  disabled={disabled || loading}
  aria-busy={loading ? 'true' : undefined}
  class={[
    'sable-button',
    `sable-button-${variant}`,
    `sable-button-${size}`,
    { 'sable-button-loading': loading },
    className,
  ]}
>
  {#if loading}<Spinner small />{/if}
  {@render children?.()}
</BitsButton.Root>
