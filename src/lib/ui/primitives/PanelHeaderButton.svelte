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

  let pressed = $derived(rest['aria-pressed']);
  let toggle = $derived(typeof pressed === 'boolean');
</script>

<IconButton
  {...rest}
  {...toggle ? { 'data-state': pressed ? 'open' : 'closed' } : {}}
  {label}
  size="small"
  variant="ghost"
  class={['panel-header-button', toggle && 'selection-open', className]}
>
  {@render children?.()}
</IconButton>
