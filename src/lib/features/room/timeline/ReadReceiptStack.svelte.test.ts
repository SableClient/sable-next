// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
import { formatMessageTimestamp } from '#lib/ui/date-time.js';

import ReadReceiptStack from './ReadReceiptStack.svelte';

const members = [
  {
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
  {
    user_id: '@carol:example.org',
    display_name: 'Carol',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

test('opens profiles from each face', async () => {
  const user = userEvent.setup();
  const onProfile = vi.fn();
  render(
    ReadReceiptStack,
    {
      readers: ['@bob:example.org', '@carol:example.org'],
      members,
      onOpen: () => {},
      onProfile,
    },
    { wrapper: TooltipProvider }
  );

  const bob = screen.getByRole('button', { name: "Open Bob's profile" });
  expect(screen.getByRole('button', { name: "Open Carol's profile" })).toBeInTheDocument();
  expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();

  await user.click(bob);
  expect(onProfile).toHaveBeenCalledWith('@bob:example.org', bob);
});

test('shows available receipt times in the face tooltip and updates them', async () => {
  const user = userEvent.setup();
  const timestamp = 1_700_000_000_000;
  const instance = render(
    ReadReceiptStack,
    {
      readers: ['@bob:example.org', '@carol:example.org'],
      timestamps: { '@bob:example.org': timestamp },
      members,
      onOpen: () => {},
    },
    { wrapper: TooltipProvider }
  );

  await user.hover(screen.getByRole('button', { name: 'Bob' }));
  const time = await screen.findByText(formatMessageTimestamp(timestamp));
  const tooltip = time.closest('[data-tooltip-content]');
  if (!tooltip) throw new Error('Receipt time has no tooltip');
  expect(tooltip).toHaveTextContent(formatMessageTimestamp(timestamp));
  expect(tooltip.querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(timestamp).toISOString()
  );
  await instance.rerender({ timestamps: {} });
  expect(tooltip.querySelector('time')).not.toBeInTheDocument();
});

test('caps faces and opens the list from overflow', async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 12 }, (_, index) => `@user${String(index)}:example.org`);
  let anchor: HTMLButtonElement | null = null;
  const instance = render(
    ReadReceiptStack,
    {
      readers: many,
      members: many.map((user_id) => ({
        user_id,
        display_name: user_id,
        avatar_url: null,
        power_level: 0,
        membership: 'join' as const,
        member_ts: null,
        kicked: false,
        service: false,
      })),
      onOpen: (element: HTMLButtonElement) => {
        anchor = element;
      },
    },
    { wrapper: TooltipProvider }
  );

  expect(document.querySelectorAll('.read-receipt-stack .avatar-root')).toHaveLength(3);
  const overflow = screen.getByRole('button', { name: /Open the list/ });
  expect(overflow).toHaveTextContent('+9');

  await user.click(overflow);
  expect(anchor).toBe(overflow);

  instance.unmount();
  render(
    ReadReceiptStack,
    { readers: [], members: [], onOpen: () => {} },
    { wrapper: TooltipProvider }
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('uses a single chip that opens the list on coarse pointers', async () => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    if (query === '(pointer: coarse)') {
      const mediaQuery = matchMedia(query);
      Object.defineProperty(mediaQuery, 'matches', { value: true });
      return mediaQuery;
    }
    return matchMedia(query);
  });

  const user = userEvent.setup();
  let anchor: HTMLButtonElement | null = null;
  render(
    ReadReceiptStack,
    {
      readers: ['@bob:example.org', '@carol:example.org'],
      members,
      onOpen: (element: HTMLButtonElement) => {
        anchor = element;
      },
      onProfile: () => {},
    },
    { wrapper: TooltipProvider }
  );

  const chip = screen.getByRole('button', { name: 'Seen by Bob, Carol. Open the list.' });
  expect(chip).toHaveClass('chip');
  expect(screen.queryByRole('button', { name: "Open Bob's profile" })).not.toBeInTheDocument();

  await user.click(chip);
  expect(anchor).toBe(chip);
});
