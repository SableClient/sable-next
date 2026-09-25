// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const files = vi.hoisted(() => ({ saveBytes: vi.fn(() => Promise.resolve('saved' as const)) }));
vi.mock('#lib/platform/files.js', () => files);

import { core } from '#lib/core/__mocks__/context.js';

const enableRecovery = vi.fn(() => Promise.resolve('EsTa bLiS hEd'));
Object.assign(core, { enableRecovery });
const writeText = vi.fn(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

import RecoverySetupCard from './RecoverySetupCard.svelte';

function render(recoveryKey: string | null = null) {
  const props = { recoveryKey, onComplete: vi.fn(), onSkip: vi.fn() };
  const instance = mount(RecoverySetupCard, { target: document.body, props });
  flushSync();
  return { instance, ...props };
}

const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((element) => name.test(element.textContent.trim()));
const keyField = () => document.querySelector<HTMLInputElement>('#new-account-recovery-key');

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('a created key cannot be left before it is kept somewhere', async () => {
  const { instance, onComplete } = render();

  button(/Create recovery key/)?.click();
  await vi.waitFor(() => {
    expect(keyField()?.value).toBe('EsTa bLiS hEd');
  });
  expect(button(/Skip for now/)).toBeUndefined();
  expect(button(/^Continue$/)?.disabled).toBe(true);
  document.querySelector('form')?.requestSubmit();
  expect(onComplete).not.toHaveBeenCalled();

  await unmount(instance);
});

test('copying the key is not enough without ticking the box', async () => {
  const { instance, onComplete } = render('given key');

  button(/^Copy$/)?.click();
  await vi.waitFor(() => {
    expect(button(/^Copied$/)).toBeDefined();
  });
  expect(writeText).toHaveBeenCalledWith('given key');
  expect(button(/^Continue$/)?.disabled).toBe(true);
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  flushSync();
  button(/^Continue$/)?.click();
  expect(onComplete).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('downloading the key saves it as a text file but still needs the box', async () => {
  const { instance } = render('given key');

  button(/^Download$/)?.click();
  await vi.waitFor(() => {
    expect(button(/^Downloaded$/)).toBeDefined();
  });
  expect(button(/^Continue$/)?.disabled).toBe(true);
  expect(files.saveBytes).toHaveBeenCalledWith(
    new TextEncoder().encode('given key\n'),
    'sable-recovery-key.txt',
    'text/plain'
  );

  await unmount(instance);
});

test('a cancelled download does not count as kept', async () => {
  files.saveBytes.mockResolvedValueOnce('cancelled' as never);
  const { instance } = render('given key');

  button(/^Download$/)?.click();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  expect(button(/^Continue$/)?.disabled).toBe(true);

  await unmount(instance);
});

test('writing it down by hand is enough', async () => {
  const { instance } = render('given key');

  document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  flushSync();
  expect(button(/^Continue$/)?.disabled).toBe(false);

  await unmount(instance);
});

test('a key handed over from an identity reset is shown without creating another', async () => {
  const { instance } = render('reset key');

  expect(keyField()?.value).toBe('reset key');
  expect(enableRecovery).not.toHaveBeenCalled();

  await unmount(instance);
});
