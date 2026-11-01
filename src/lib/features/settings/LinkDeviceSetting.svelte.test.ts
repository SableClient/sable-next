// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import LinkDeviceSetting from './LinkDeviceSetting.svelte';

test('offers QR device linking', () => {
  render(LinkDeviceSetting);

  expect(screen.getByRole('button', { name: 'Link device' })).toBeInTheDocument();
});
