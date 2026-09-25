<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import type { ButtonProps } from './button-types';

  type Props = Omit<ButtonProps, 'children' | 'class' | 'size' | 'variant'> & {
    label: string;
    class?: ClassValue;
    children?: Snippet;
  };

  let { label, class: className = '', children, ...rest }: Props = $props();
</script>

<IconButton
  {...rest}
  {label}
  size="small"
  variant="ghost"
  class={['panel-header-button', className]}
>
  {@render children?.()}
</IconButton>
