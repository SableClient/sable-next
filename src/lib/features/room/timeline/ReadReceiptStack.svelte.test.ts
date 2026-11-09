// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
import { formatMessageTimestamp } from '#lib/ui/date-time.js';

import { mockStillFrames, STILL } from '#lib/test-support/still-frame.js';
import ReadReceiptStack from './ReadReceiptStack.svelte';

afterEach(() => {
  core.fetchMedia.mockReset();
  vi.restoreAllMocks();
});

const members = [
  {
    user_id: '@bob:example.org',
    display_name: 'Bob',
    real_name: 'Bob',
    real_avatar_url: null,
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
    real_name: 'Carol',
    real_avatar_url: null,
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

test.each(['article', 'div'])('receipt avatars play only on hover inside <%s>', async (tag) => {
  const gif = new TextEncoder().encode('GIF89a');
  core.fetchMedia.mockResolvedValue(gif);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    blob: () => Promise.resolve(new Blob([gif])),
  } as Response);
  mockStillFrames(URL.createObjectURL.bind(URL));
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(32);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(32);
  const container = document.body.appendChild(document.createElement(tag));
  onTestFinished(() => {
    container.remove();
  });
  const source = `mxc://example.org/receipt-${tag}`;
  render(
    ReadReceiptStack,
    {
      target: container,
      props: {
        readers: [members[0].user_id],
        members: [{ ...members[0], avatar_url: source }],
        onOpen: () => {},
      },
    },
    { wrapper: TooltipProvider }
  );

  const layers = () => container.querySelectorAll<HTMLElement>('.avatar-image');
  await vi.waitFor(() => {
    expect(layers()[0]?.querySelector('img')).not.toBeNull();
  });
  const thumbnail = layers()[0].querySelector('img');
  if (!thumbnail) throw new Error('receipt picture not rendered');
  await fireEvent.load(thumbnail);
  await vi.waitFor(() => {
    expect(thumbnail.getAttribute('src')).toBe(STILL);
  });
  expect(layers()).toHaveLength(1);
  expect(core.fetchMedia).not.toHaveBeenCalledWith(source, 0, 0);

  const hoverTarget = tag === 'article' ? container : container.querySelector('.avatar-root');
  if (!hoverTarget) throw new Error('receipt hover target not rendered');
  await fireEvent.pointerEnter(hoverTarget, { pointerType: 'touch' });
  expect(layers()).toHaveLength(1);

  await fireEvent.pointerEnter(hoverTarget, { pointerType: 'mouse' });
  expect(layers()).toHaveLength(2);
  expect(core.fetchMedia).toHaveBeenCalledWith(source, 0, 0);
  await vi.waitFor(() => {
    expect(layers()[1]?.querySelector('img')).not.toBeNull();
  });
  const animated = layers()[1].querySelector('img');
  if (!animated) throw new Error('animated receipt picture not rendered');
  await fireEvent.load(animated);
  await vi.waitFor(() => {
    expect(layers()[1]?.style.opacity).toBe('');
  });

  await fireEvent.pointerLeave(hoverTarget, { pointerType: 'mouse' });
  expect(layers()).toHaveLength(1);
  expect(thumbnail.getAttribute('src')).toBe(STILL);
});

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

  const bob = screen.getByRole('button', { name: 'Open Bob’s profile' });
  expect(screen.getByRole('button', { name: 'Open Carol’s profile' })).toBeInTheDocument();
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
        real_name: user_id,
        real_avatar_url: null,
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

  expect(document.querySelectorAll('.read-receipt-stack .avatar-root')).toHaveLength(2);
  const overflow = screen.getByRole('button', { name: /Open the list/ });
  expect(overflow).toHaveTextContent('+10');

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

  const chip = screen.getByRole('button', { name: 'Seen by Bob and Carol. Open the list.' });
  expect(chip).toHaveClass('chip');
  expect(screen.queryByRole('button', { name: 'Open Bob’s profile' })).not.toBeInTheDocument();

  await user.click(chip);
  expect(anchor).toBe(chip);
});
