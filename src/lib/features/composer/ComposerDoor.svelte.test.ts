// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import ComposerDoor from './ComposerDoor.svelte';

test('on a phone, pressing the insert button opens it even if the keyboard closing moves it before release', async () => {
  const onBeforeOpen = vi.fn();
  render(ComposerDoor, { desktop: false, onPick: () => {}, onBeforeOpen });
  const door = screen.getByRole('button', { name: 'Insert' });

  await fireEvent.pointerDown(door);
  await tick();

  expect(onBeforeOpen).toHaveBeenCalledOnce();
  expect(door).toHaveAttribute('data-state', 'open');
});
