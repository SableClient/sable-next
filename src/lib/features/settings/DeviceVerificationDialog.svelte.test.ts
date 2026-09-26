// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

Object.assign(core, {
  acceptVerification: vi.fn(() => Promise.resolve()),
  cancelVerification: vi.fn(() => Promise.resolve()),
  confirmVerification: vi.fn(() => Promise.resolve()),
  session: { user_id: '@alice:example.org' },
  verification: {
    flowId: 'flow',
    state: {
      phase: 'compare' as const,
      emojis: [
        { symbol: '🐶', description: 'Dog' },
        { symbol: '🐶', description: 'Dog again' },
      ],
      decimals: [1, 2, 3] as [number, number, number],
    },
  },
});

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

test('renders every SAS emoji slot when a symbol repeats', () => {
  render(DeviceVerificationDialog);

  expect(screen.getAllByText('🐶')).toHaveLength(2);
  expect(screen.getByText('Dog')).toBeInTheDocument();
  expect(screen.getByText('Dog again')).toBeInTheDocument();
});
