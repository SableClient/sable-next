import { cubicIn, cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import { fly, type FlyParams } from 'svelte/transition';

import { preferences } from '#lib/settings/preferences.svelte.js';

/** Keep these in sync with the duration tokens in `src/styles.css`. */
export const MOTION_MS = {
  micro: 80,
  quick: 150,
  fast: 250,
  medium: 350,
  slow: 400,
} as const;

export function shouldReduceMotion(): boolean {
  return preferences.reducedMotion || prefersReducedMotion.current;
}

export function motionMs(duration: number): number {
  return shouldReduceMotion() ? 0 : duration;
}

export function scrollBehavior(): ScrollBehavior {
  return shouldReduceMotion() ? 'auto' : 'smooth';
}

type PanelMotion = { modal?: boolean; cover?: boolean };

function panelFly(node: Element, { modal = false, cover = false }: PanelMotion, leaving: boolean) {
  const params: FlyParams = {
    x: cover ? '100%' : 24,
    opacity: cover ? 1 : 0,
    duration: modal ? 0 : motionMs(leaving ? MOTION_MS.quick : MOTION_MS.fast),
    easing: leaving ? cubicIn : cubicOut,
  };
  return fly(node, params);
}

/**
 * A panel arriving from the trailing edge: a short slide beside the conversation, a full push when it
 * covers it. A modal one already has the drawer's motion.
 */
export function panelIn(node: Element, motion: PanelMotion = {}) {
  return panelFly(node, motion, false);
}

/** The same path out, faster. */
export function panelOut(node: Element, motion: PanelMotion = {}) {
  return panelFly(node, motion, true);
}
