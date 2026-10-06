// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import SupporterBadgePicker from './SupporterBadgePicker.svelte';
import { supporterAppearance } from './variants.js';

const props = { value: supporterAppearance(), onChange: () => {} };

test('lets a donor choose Ceoable', async () => {
  const onChange = vi.fn();
  render(SupporterBadgePicker, { ...props, onChange });

  expect(screen.getByRole('radio', { name: 'Pride' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Ceoable' }));
  expect(onChange).toHaveBeenCalledWith({ variant: 'ceo' });
});
