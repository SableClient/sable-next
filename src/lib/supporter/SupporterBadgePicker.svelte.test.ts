// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import SupporterBadgePicker from './SupporterBadgePicker.svelte';
import { supporterAppearance } from './variants.js';

const props = { value: supporterAppearance(), onChange: () => {} };

test('hides the ceo badge from a plain donor', () => {
  render(SupporterBadgePicker, { ...props, tier: null });

  expect(screen.getByRole('radio', { name: 'Pride' })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'CEO' })).not.toBeInTheDocument();
});

test('offers the ceo badge to the ceo tier', () => {
  render(SupporterBadgePicker, { ...props, tier: 'ceo' });

  expect(screen.getByRole('radio', { name: 'CEO' })).toBeInTheDocument();
});
