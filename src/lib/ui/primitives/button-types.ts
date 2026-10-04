import type { Snippet } from 'svelte';
import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger';
export type ButtonSize = 'small' | 'medium' | 'icon';
export type IconButtonSize = 'small' | 'medium' | 'large';

export type ButtonProps = Omit<HTMLButtonAttributes, 'class' | 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  class?: ClassValue;
  children?: Snippet;
};
