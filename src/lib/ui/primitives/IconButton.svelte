<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import IconContext from 'phosphor-svelte/lib/IconContext';

  import Button from './Button.svelte';
  import type { ButtonProps, IconButtonSize } from './button-types';

  type Props = Omit<ButtonProps, 'children' | 'class' | 'size'> & {
    label: string;
    size?: IconButtonSize;
    class?: ClassValue;
    children?: Snippet;
  };

  let { label, size = 'medium', class: className = '', children, ...rest }: Props = $props();
</script>

<Button
  {...rest}
  size="icon"
  aria-label={label}
  class={['icon-button', `icon-button-${size}`, className]}
>
  <IconContext values={{ 'aria-hidden': 'true' }}>
    {@render children?.()}
  </IconContext>
</Button>
