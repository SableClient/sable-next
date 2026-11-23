// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import ForumToolbar from './ForumToolbar.svelte';

function enter(target: Element, keyCode: number): void {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  target.dispatchEvent(event);
}

test('submits on Enter but not on the Enter that commits an IME composition', () => {
  const onSubmit = vi.fn();
  render(ForumToolbar, {
    query: '',
    view: { sort: 'active', layout: 'list' },
    onView: () => {},
    onSubmit,
  });
  const search = screen.getByRole('searchbox');

  enter(search, 229);
  expect(onSubmit).not.toHaveBeenCalled();

  enter(search, 13);
  expect(onSubmit).toHaveBeenCalledOnce();
});
