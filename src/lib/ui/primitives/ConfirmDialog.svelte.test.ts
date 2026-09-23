// @vitest-environment happy-dom

import { createRawSnippet, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import ConfirmDialog from './ConfirmDialog.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('confirms with the danger variant by default', async () => {
  const instance = mount(ConfirmDialog, {
    target: document.body,
    props: { open: true, title: 'Remove', confirmLabel: 'Remove' },
  });
  await tick();

  expect(document.querySelector('button[type="submit"]')?.className).toContain('btn-danger');
  expect(document.querySelector('[role="alert"]')).toBeNull();

  await unmount(instance);
});

test('reports a cancel', async () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const instance = mount(ConfirmDialog, {
    target: document.body,
    props: { open: true, title: 'Remove', confirmLabel: 'Remove', onCancel, onConfirm },
  });
  await tick();

  document.querySelector<HTMLButtonElement>('button[type="button"]')?.click();

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();

  await unmount(instance);
});

test('renders a field, the chosen confirm variant and an error line', async () => {
  const instance = mount(ConfirmDialog, {
    target: document.body,
    props: {
      open: true,
      title: 'Rename',
      confirmLabel: 'Save',
      confirmVariant: 'secondary',
      error: 'Name taken',
      children: createRawSnippet(() => ({ render: () => '<input id="field" />' })),
    },
  });
  await tick();

  const submit = document.querySelector('button[type="submit"]');
  expect(submit?.className).toContain('btn-secondary');
  expect(submit?.className).not.toContain('btn-danger');
  expect(document.querySelector('form #field')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent.trim()).toBe('Name taken');

  await unmount(instance);
});
