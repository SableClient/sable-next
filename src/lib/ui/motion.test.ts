// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { motionMs, panelIn, panelOut, scrollBehavior, shouldReduceMotion } from './motion.js';

const systemMotionPreference = vi.hoisted(() => ({ current: false }));

vi.mock('svelte/motion', () => ({ prefersReducedMotion: systemMotionPreference }));

const original = preferences.reducedMotion;

afterEach(() => {
  preferences.reducedMotion = original;
  systemMotionPreference.current = false;
});

test('the in-app setting reduces motion even when the OS has no preference', () => {
  preferences.reducedMotion = true;
  expect(shouldReduceMotion()).toBe(true);
  expect(motionMs(250)).toBe(0);
  expect(scrollBehavior()).toBe('auto');
});

test('the OS setting reduces motion when the in-app setting is off', () => {
  preferences.reducedMotion = false;
  systemMotionPreference.current = true;
  expect(shouldReduceMotion()).toBe(true);
  expect(motionMs(250)).toBe(0);
  expect(scrollBehavior()).toBe('auto');
});

test('motion is preserved when neither setting requests a reduction', () => {
  preferences.reducedMotion = false;
  systemMotionPreference.current = false;
  expect(shouldReduceMotion()).toBe(false);
  expect(motionMs(250)).toBe(250);
  expect(scrollBehavior()).toBe('smooth');
});

test('a panel holds still while its stage is not live', () => {
  preferences.reducedMotion = false;
  const node = document.createElement('aside');
  const swapping = () => false;
  expect(panelIn(node, { stage: { live: false, swapping } }).duration).toBe(0);
  expect(panelOut(node, { stage: { live: false, swapping } }).duration).toBe(0);
  expect(panelIn(node, { stage: { live: true, swapping } }).duration).toBe(250);
  expect(panelIn(node).duration).toBe(250);
});

test('a panel replacing another holds still', () => {
  preferences.reducedMotion = false;
  const node = document.createElement('aside');
  const stage = { live: true, swapping: () => true };
  expect(panelIn(node, { stage }).duration).toBe(0);
  expect(panelOut(node, { stage }).duration).toBe(0);
});
