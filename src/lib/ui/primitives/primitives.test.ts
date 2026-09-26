// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import Alert from './Alert.svelte';
import AppPageShell from './AppPageShell.svelte';
import Avatar from './Avatar.svelte';
import Button from './Button.svelte';
import EmptyState from './EmptyState.svelte';
import IconButton from './IconButton.svelte';
import LinkButton from './LinkButton.svelte';
import OptionCards from './OptionCards.svelte';
import Skeleton from './Skeleton.svelte';
import Spinner from './Spinner.svelte';
import StatusBadge from './StatusBadge.svelte';
import TextArea from './TextArea.svelte';

test('button variants expose loading and disabled state consistently', () => {
  render(Button, { variant: 'primary', size: 'large', loading: true, block: true });

  const button = screen.getByRole('button');
  expect(button).toHaveClass('btn-primary', 'btn-large', 'btn-loading', 'btn-block');
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
});

test('icon and link buttons retain accessible labels and shared styling', () => {
  render(IconButton, { label: 'Close', variant: 'ghost', size: 'small' });
  render(LinkButton, { href: '/home', variant: 'primary', block: true });

  expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('icon-button-small');
  const link = screen.getByRole('link');
  expect(link).toHaveAttribute('href', '/home');
  expect(link).toHaveClass('btn-primary', 'btn-block');
});

test('content primitives expose semantic state and input affordances', () => {
  render(TextArea, { value: 'draft', error: true, disabled: true });
  render(Avatar, { initials: 'S', alt: 'Sable', size: 'small' });
  render(Alert, { variant: 'critical', role: 'alert' });
  render(StatusBadge, { label: 'Verified', variant: 'success' });

  const textbox = screen.getByRole('textbox');
  expect(textbox).toHaveClass('form-control-error');
  expect(textbox).toBeDisabled();
  expect(screen.getByRole('img', { name: 'Sable' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveClass('alert-critical');
  expect(screen.getByText('Verified').closest('.status-badge')).toHaveClass('status-badge-success');
});

test('decorative avatars stay out of the accessibility tree', () => {
  const { container } = render(Avatar, { initials: 'S', decorative: true });

  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(container.querySelector('.avatar-root')).toHaveAttribute('aria-hidden', 'true');
});

test('option cards are one radio group with a single checked item', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(OptionCards, {
    label: 'Visibility',
    value: 'private',
    onSelect,
    options: [
      { value: 'private', label: 'Private', hint: 'Invite only' },
      { value: 'public', label: 'Public' },
      { value: 'space', label: 'Space', disabled: true },
    ],
  });

  expect(screen.getByRole('radiogroup', { name: 'Visibility' })).toBeInTheDocument();
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(3);
  expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Private/);
  expect(screen.getByRole('radio', { name: 'Space' })).toHaveAttribute('data-disabled');
  expect(radios.filter((radio) => radio.getAttribute('tabindex') !== '-1')).toHaveLength(1);

  await user.click(screen.getByRole('radio', { name: 'Public' }));

  expect(onSelect).toHaveBeenCalledWith('public');
});

test('a labelled spinner announces loading without exposing the glyph', () => {
  const { container } = render(Spinner, { label: 'Loading' });

  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(container.querySelector('.spinner')).toHaveAttribute('aria-hidden', 'true');
});

test('an unlabelled spinner stays a decorative glyph', () => {
  const { container } = render(Spinner);

  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(container.querySelector('.spinner')).toHaveAttribute('aria-hidden', 'true');
});

test('skeletons are decorative and forward presentation attributes', () => {
  const { container } = render(Skeleton, {
    class: 'message-placeholder',
    style: 'width: 12rem',
  });

  const skeleton = container.querySelector('.skeleton');
  expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  expect(skeleton).toHaveClass('message-placeholder');
  expect(skeleton).toHaveAttribute('style', expect.stringContaining('width: 12rem'));
});

test('page composition primitives provide labelled layout landmarks', () => {
  render(EmptyState, {
    title: 'Nothing here',
    description: 'Try another place',
    titleId: 'empty-heading',
  });
  render(AppPageShell, { title: 'Settings', description: 'Manage your account' });

  expect(screen.getByText('Nothing here')).toHaveAttribute('id', 'empty-heading');
  const main = screen.getByRole('main');
  expect(main).toHaveClass('app-page-shell');
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
});
