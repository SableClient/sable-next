import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import Switcher from './Switcher.svelte';
import SettingsSelectHarness from './SettingsSelectHarness.test.svelte';

const items = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

test('changes one native radio selection and submits the selected form value', async () => {
  const onValueChange = vi.fn();
  const { container } = render(Switcher, {
    items,
    value: 'dark',
    label: 'Theme',
    name: 'theme',
    onValueChange,
  });
  const form = document.createElement('form');
  document.body.append(form);
  form.append(container);
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
  expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked();
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('light');
  expect(new FormData(form).get('theme')).toBe('light');
  form.remove();
});

test('disabled choices preserve the selected value', () => {
  const onValueChange = vi.fn();
  render(Switcher, { items, value: 'dark', label: 'Theme', disabled: true, onValueChange });
  const light = screen.getByRole('radio', { name: 'Light' }) as HTMLInputElement;
  expect(light).toBeDisabled();
  light.click();
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(onValueChange).not.toHaveBeenCalled();
});

test('settings selects expose small choice sets and keep longer lists as dropdowns', () => {
  const { unmount } = render(SettingsSelectHarness, { items });
  expect(screen.getByRole('radiogroup', { name: 'Setting' })).toBeInTheDocument();
  unmount();
  render(SettingsSelectHarness, {
    items: [...items, { value: 'system', label: 'System' }, { value: 'custom', label: 'Custom' }],
  });
  expect(screen.queryByRole('radiogroup', { name: 'Setting' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Setting')).toHaveAttribute('aria-haspopup');
});

test('settings selects can keep short choice sets in a dropdown', () => {
  render(SettingsSelectHarness, { items, forceDropdown: true });
  expect(screen.queryByRole('radiogroup', { name: 'Setting' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Setting')).toHaveAttribute('aria-haspopup');
});
