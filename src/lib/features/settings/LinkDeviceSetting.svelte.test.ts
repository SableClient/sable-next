// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import LinkDeviceSetting from './LinkDeviceSetting.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

test('shows QR device linking in Account when the homeserver supports OAuth', async () => {
  Object.assign(core, {
    devices: vi.fn(() => Promise.resolve({ devices: [], accountManagement: false, oauth: true })),
  });
  render(LinkDeviceSetting);

  expect(await screen.findByRole('button', { name: 'Link' })).toBeInTheDocument();
});

test('hides QR device linking when the homeserver does not support OAuth', async () => {
  Object.assign(core, {
    devices: vi.fn(() => Promise.resolve({ devices: [], accountManagement: false, oauth: false })),
  });
  render(LinkDeviceSetting);

  await vi.waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
  });
});
