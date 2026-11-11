import { beforeNavigate } from '$app/navigation';
import { createContext, onMount } from 'svelte';
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

interface PanelStage {
  live: boolean;
  swapping: () => boolean;
}

const [getPanelStage, setPanelStage, hasPanelStage] = createContext<PanelStage>();

export function providePanelStage(swapping: () => boolean = () => false): void {
  const stage: PanelStage = { live: false, swapping };
  setPanelStage(stage);
  onMount(() => {
    const frame = requestAnimationFrame(() => {
      stage.live = true;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  });
  beforeNavigate(({ from, to, complete }) => {
    if (from?.url.pathname === to?.url.pathname) return;
    stage.live = false;
    const settle = () => {
      stage.live = true;
    };
    void complete.then(settle, settle);
  });
}

export function usePanelStage(): PanelStage | undefined {
  return hasPanelStage() ? getPanelStage() : undefined;
}

type PanelMotion = { modal?: boolean; cover?: boolean; stage?: PanelStage };

function panelFly(
  node: Element,
  { modal = false, cover = false, stage }: PanelMotion,
  leaving: boolean
) {
  const still = modal || stage?.live === false || stage?.swapping() === true;
  const params: FlyParams = {
    x: cover ? '100%' : 24,
    opacity: cover ? 1 : 0,
    duration: still ? 0 : motionMs(leaving ? MOTION_MS.quick : MOTION_MS.fast),
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
