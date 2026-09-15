import { cubicOut } from 'svelte/easing';

interface TransitionOptions {
  duration: number;
}

export function smoothSlide(_node: HTMLElement, { duration }: TransitionOptions) {
  return {
    duration,
    easing: cubicOut,
    css: (t: number) => `
      display: grid;
      grid-template-rows: ${String(t)}fr;
      min-height: 0;
      opacity: ${String(t)};
      overflow: hidden;
    `,
  };
}
