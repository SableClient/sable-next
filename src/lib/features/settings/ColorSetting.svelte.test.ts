// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import ColorSetting from './ColorSetting.svelte';

test('opens the picker from its swatch', async () => {
  const user = userEvent.setup();
  render(ColorSetting, {
    label: 'Profile color',
    value: '',
    onCommit: vi.fn(),
    onReset: vi.fn(),
  });

  const trigger = screen.getByRole('button', { name: 'Choose Profile color' });
  await user.click(trigger);

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
});
