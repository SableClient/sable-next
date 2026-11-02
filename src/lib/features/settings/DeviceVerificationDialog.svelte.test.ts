// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { flushed } from '#lib/ui/flushed.js';

const cancelVerification = vi.fn(() => Promise.resolve());

Object.assign(core, {
  requestVerification: vi.fn(() => Promise.resolve('retried')),
  session: { user_id: '@alice:example.org' },
  verification: {
    userId: '@alice:example.org',
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
Object.assign(core.rpc.encryption, {
  acceptVerification: vi.fn(() => Promise.resolve()),
  cancelVerification,
  confirmVerification: vi.fn(() => Promise.resolve()),
});

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

test('renders every SAS emoji slot when a symbol repeats', () => {
  render(DeviceVerificationDialog);

  expect(screen.getAllByText('🐶')).toHaveLength(2);
  expect(screen.getByText('Dog')).toBeInTheDocument();
  expect(screen.getByText('Dog again')).toBeInTheDocument();
});

test('each emoji is one labelled group so nothing is read twice', () => {
  render(DeviceVerificationDialog);

  const dog = screen.getByRole('group', { name: 'Dog' });
  expect(dog.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
});

test('the status region stays mounted and announces the current phase', async () => {
  const active = $state<{ current: unknown }>({
    current: {
      userId: '@alice:example.org',
      flowId: 'flow',
      state: { phase: 'waiting' as const },
    },
  });
  Object.defineProperty(core, 'verification', {
    configurable: true,
    get: () => active.current,
    set: (next: unknown) => {
      active.current = next;
    },
  });
  render(DeviceVerificationDialog);

  const region = await screen.findByRole('status');
  expect(region).toHaveTextContent('Waiting for the other device');

  active.current = {
    userId: '@alice:example.org',
    flowId: 'flow',
    state: { phase: 'done' as const },
  };
  await flushed();
  expect(screen.getByRole('status')).toBe(region);
  expect(region).toHaveTextContent('verified');
  expect(document.querySelector('.verification-title')).toHaveFocus();
});

test('a silent emoji comparison can be cancelled and requested again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  core.verification = {
    userId: '@alice:example.org',
    flowId: 'flow',
    state: { phase: 'waiting' as const },
  };
  render(DeviceVerificationDialog);
  await screen.findByRole('dialog');
  expect(screen.queryByRole('button', { name: 'Send the request again' })).toBeNull();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(await screen.findByRole('button', { name: 'Send the request again' })).toBeInTheDocument();
});

test('dismissing an active flow cancels it and clears it so a new request can reopen the panel', async () => {
  core.verification = {
    userId: '@alice:example.org',
    flowId: 'flow',
    state: { phase: 'requested' as const, is_self: true, initiated_by_us: true },
  };
  render(DeviceVerificationDialog);

  const user = userEvent.setup();
  await screen.findByRole('dialog');
  await user.keyboard('{Escape}');

  await vi.waitFor(() => {
    expect(cancelVerification).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      flow_id: 'flow',
      mismatch: false,
    });
    expect(core.verification).toBeNull();
  });
});

test('a request nobody answers can be cancelled and sent again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  core.verification = {
    userId: '@alice:example.org',
    flowId: 'flow',
    state: { phase: 'requested' as const, is_self: true, initiated_by_us: true },
  };
  render(DeviceVerificationDialog);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await screen.findByRole('dialog');
  expect(screen.queryByRole('button', { name: 'Send the request again' })).toBeNull();

  await vi.advanceTimersByTimeAsync(30_000);
  await user.click(await screen.findByRole('button', { name: 'Send the request again' }));

  expect(cancelVerification).toHaveBeenCalledWith({
    user_id: '@alice:example.org',
    flow_id: 'flow',
    mismatch: false,
  });
  await vi.waitFor(() => {
    expect(core.requestVerification).toHaveBeenCalledWith('@alice:example.org');
  });
});

test('an error stays with its flow and clears when another flow takes over', async () => {
  const compare = {
    phase: 'compare' as const,
    emojis: [{ symbol: '🐶', description: 'Dog' }],
    decimals: [1, 2, 3] as [number, number, number],
  };
  const active = $state<{ current: unknown }>({
    current: { userId: '@alice:example.org', flowId: 'first', state: compare },
  });
  Object.defineProperty(core, 'verification', {
    configurable: true,
    get: () => active.current,
    set: (next: unknown) => {
      active.current = next;
    },
  });
  vi.mocked(core.rpc.encryption.confirmVerification).mockRejectedValueOnce(new Error('nope'));
  render(DeviceVerificationDialog);

  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'They match' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();

  active.current = { userId: '@alice:example.org', flowId: 'first', state: { ...compare } };
  await flushed();
  expect(screen.getByRole('alert')).toBeInTheDocument();

  active.current = { userId: '@alice:example.org', flowId: 'second', state: { ...compare } };
  await vi.waitFor(() => {
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
