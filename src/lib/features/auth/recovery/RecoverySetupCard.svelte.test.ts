// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const files = vi.hoisted(() => ({ saveBytes: vi.fn(() => Promise.resolve('saved' as const)) }));
vi.mock('#lib/platform/files.js', () => files);

import { core } from '#lib/core/__mocks__/context.js';

const enableRecovery = vi.fn(() => Promise.resolve('EsTa bLiS hEd'));
Object.assign(core, { enableRecovery });

import RecoverySetupCard from './RecoverySetupCard.svelte';

function setup(recoveryKey: string | null = null) {
  const props = { recoveryKey, onComplete: vi.fn(), onSkip: vi.fn() };
  render(RecoverySetupCard, props);
  return { user: userEvent.setup(), ...props };
}

const button = (name: RegExp) => screen.queryByRole('button', { name });
const keyField = () => screen.getByRole('textbox', { name: 'Recovery key' });
const writtenDown = () => screen.getByRole('checkbox');
const continueButton = () => screen.getByRole('button', { name: /^Continue$/ });

afterEach(() => {
  vi.clearAllMocks();
});

test('a created key cannot be left before it is kept somewhere', async () => {
  const { user, onComplete } = setup();

  await user.click(screen.getByRole('button', { name: /Create recovery key/ }));
  await vi.waitFor(() => {
    expect(keyField()).toHaveValue('EsTa bLiS hEd');
  });
  expect(button(/Skip for now/)).not.toBeInTheDocument();
  expect(continueButton()).toBeDisabled();
  await user.type(keyField(), '{Enter}');
  expect(onComplete).not.toHaveBeenCalled();
});

test('copying the key is not enough without ticking the box', async () => {
  const { user, onComplete } = setup('given key');

  await user.click(screen.getByRole('button', { name: /^Copy$/ }));
  expect(await screen.findByRole('button', { name: /^Copied$/ })).toBeInTheDocument();
  expect(await navigator.clipboard.readText()).toBe('given key');
  expect(continueButton()).toBeDisabled();
  await user.click(writtenDown());
  await user.click(continueButton());
  expect(onComplete).toHaveBeenCalledOnce();
});

test('downloading the key saves it as a text file but still needs the box', async () => {
  const { user } = setup('given key');

  await user.click(screen.getByRole('button', { name: /^Download$/ }));
  expect(await screen.findByRole('button', { name: /^Downloaded$/ })).toBeInTheDocument();
  expect(continueButton()).toBeDisabled();
  expect(files.saveBytes).toHaveBeenCalledWith(
    new TextEncoder().encode('given key\n'),
    'sable-recovery-key.txt',
    'text/plain'
  );
});

test('a cancelled download does not count as kept', async () => {
  files.saveBytes.mockResolvedValueOnce('cancelled' as never);
  const { user } = setup('given key');

  await user.click(screen.getByRole('button', { name: /^Download$/ }));
  await vi.waitFor(() => {
    expect(files.saveBytes).toHaveBeenCalled();
  });
  expect(button(/^Downloaded$/)).not.toBeInTheDocument();
  expect(continueButton()).toBeDisabled();
});

test('writing it down by hand is enough', async () => {
  const { user } = setup('given key');

  await user.click(writtenDown());
  expect(continueButton()).toBeEnabled();
});

test('a key handed over from an identity reset is shown without creating another', () => {
  setup('reset key');

  expect(keyField()).toHaveValue('reset key');
  expect(enableRecovery).not.toHaveBeenCalled();
});
