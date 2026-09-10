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
    block = false,
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
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    { 'btn-loading': loading },
    { 'btn-block': block },
    className,
  ]}
>
  {#if loading}<Spinner small />{/if}
  {@render children?.()}
</BitsButton.Root>
