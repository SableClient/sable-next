// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { expect, test, vi } from 'vitest';

import ConfirmDialog from './ConfirmDialog.svelte';

test('confirms with the danger variant by default', async () => {
  render(ConfirmDialog, { open: true, title: 'Remove', confirmLabel: 'Remove' });

  expect(await screen.findByRole('button', { name: 'Remove' })).toHaveClass('btn-danger');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('reports a cancel', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(ConfirmDialog, {
    open: true,
    title: 'Remove',
    confirmLabel: 'Remove',
    onCancel,
    onConfirm,
  });

  await user.click(await screen.findByRole('button', { name: 'Cancel' }));

  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

test('tells the owner of a one-way open prop that cancel closed it', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(ConfirmDialog, { open: true, title: 'Remove', confirmLabel: 'Remove', onOpenChange });

  await user.click(await screen.findByRole('button', { name: 'Cancel' }));

  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
});

test('renders a field, the chosen confirm variant and an error line', async () => {
  render(ConfirmDialog, {
    open: true,
    title: 'Rename',
    confirmLabel: 'Save',
    confirmVariant: 'secondary',
    error: 'Name taken',
    children: createRawSnippet(() => ({ render: () => '<input id="field" />' })),
  });

  const submit = await screen.findByRole('button', { name: 'Save' });
  expect(submit).toHaveClass('btn-secondary');
  expect(submit).not.toHaveClass('btn-danger');
  expect(submit).toHaveAttribute('type', 'submit');
  expect(screen.getByRole('textbox').closest('form')).toBe(submit.closest('form'));
  expect(screen.getByRole('alert')).toHaveTextContent('Name taken');
});

test('announces its description with the dialog', async () => {
  render(ConfirmDialog, {
    open: true,
    title: 'Remove',
    description: 'This cannot be undone.',
    confirmLabel: 'Remove',
  });

  expect(await screen.findByRole('dialog')).toHaveAccessibleDescription('This cannot be undone.');
});
