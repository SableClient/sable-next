<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue, HTMLAnchorAttributes } from 'svelte/elements';

  import type { ButtonSize, ButtonVariant } from './button-types';
  import './button.css';

  type Props = Omit<HTMLAnchorAttributes, 'class' | 'children' | 'href'> & {
    href: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    block?: boolean;
    class?: ClassValue;
    children?: Snippet;
  };

  let {
    variant = 'secondary',
    size = 'medium',
    block = false,
    class: className = '',
    children,
    ...rest
  }: Props = $props();
</script>

<a
  {...rest}
  class={[
    'sable-button',
    `sable-button-${variant}`,
    `sable-button-${size}`,
    { 'sable-button-block': block },
    className,
  ]}
>
  {@render children?.()}
</a>
