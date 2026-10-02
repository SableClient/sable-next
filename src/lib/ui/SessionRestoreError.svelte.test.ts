// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { goto } from '$app/navigation';
vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/migrations/v1/migration.js', () => ({ skipV1Migration: vi.fn() }));
import { skipV1Migration } from '#lib/migrations/v1/migration.js';
import { core } from '#lib/core/__mocks__/context.js';
import SessionRestoreError from './SessionRestoreError.svelte';

beforeEach(() => {
  Object.assign(core, {
    status: 'error',
    migrationFailed: false,
    migrationError: null,
    accounts: [],
    start: vi.fn(),
    beginSignInRecovery: vi.fn(),
    switchAccount: vi.fn().mockResolvedValue(undefined),
  });
});

test('retries restoration from the error screen', async () => {
  const start = vi.fn();
  Object.assign(core, { status: 'error', start });
  render(SessionRestoreError);
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(start).toHaveBeenCalledOnce();
});

test('disables retry while restoration is running', () => {
  Object.assign(core, { status: 'starting', start: vi.fn() });
  render(SessionRestoreError);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
});

test('offers a fresh-device sign-in route without deleting saved data', async () => {
  render(SessionRestoreError);
  expect(screen.getByText(/keeps your saved account data/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(core.beginSignInRecovery).toHaveBeenCalledOnce();
  expect(goto).toHaveBeenCalledWith('/login?addAccount=1');
});

test('keeps restoration blocked until the fresh sign-in route is ready', async () => {
  let navigated = () => {};
  vi.mocked(goto).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        navigated = resolve;
      })
  );
  render(SessionRestoreError);
  await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(core.beginSignInRecovery).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  navigated();
  await vi.waitFor(() => {
    expect(core.beginSignInRecovery).toHaveBeenCalledOnce();
  });
});

test('failed navigation keeps saved-session recovery available', async () => {
  vi.mocked(goto).mockRejectedValueOnce(new Error('navigation failed'));
  render(SessionRestoreError);
  await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(core.beginSignInRecovery).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('can select another saved account while restoration is blocked', async () => {
  Object.assign(core, {
    accounts: [
      { account_id: 'broken', user_id: '@one:x', device_id: 'ONE', needs_reauth: true },
      { account_id: 'healthy', user_id: '@two:x', device_id: 'TWO', needs_reauth: false },
    ],
  });
  render(SessionRestoreError);
  expect(screen.queryByRole('button', { name: /@one:x/ })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: /@two:x/ }));
  expect(core.switchAccount).toHaveBeenCalledWith('healthy');
  expect(goto).toHaveBeenCalledWith('/rooms');
});

test('a failed account switch leaves retry and sign-in available', async () => {
  Object.assign(core, {
    accounts: [{ account_id: 'broken', user_id: '@one:x', device_id: 'ONE', needs_reauth: false }],
    switchAccount: vi.fn().mockRejectedValue(new Error('missing crypto')),
  });
  render(SessionRestoreError);
  await fireEvent.click(screen.getByRole('button', { name: /@one:x/ }));
  expect(goto).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('migration failures preserve data and show retry without a misleading fresh-device sign-in', () => {
  Object.assign(core, { migrationFailed: true });
  render(SessionRestoreError);
  expect(screen.getByText(/Your original data is still saved/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
});

test('a failed migration can be skipped so the app starts', async () => {
  const start = vi.fn();
  Object.assign(core, {
    migrationFailed: true,
    migrationError: 'A v1 account is incomplete; its data has been kept',
    start,
  });
  render(SessionRestoreError);
  expect(
    screen.getByText('A v1 account is incomplete; its data has been kept')
  ).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Continue without v1 data' }));
  await vi.waitFor(() => {
    expect(start).toHaveBeenCalledOnce();
  });
  expect(skipV1Migration).toHaveBeenCalledOnce();
});
