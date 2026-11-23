import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');

import '../../../styles.css';
import { core } from '#lib/core/__mocks__/context.js';
import InAppBanner from './InAppBanner.svelte';
import type { Banner } from './in-app-banners.svelte';

const banner: Banner = {
  roomId: '!room:example.org',
  userId: '@me:example.org',
  eventId: '$one',
  title: 'Room',
  body: 'Bob: hello',
  segments: ['Bob: hello'],
  avatar: null,
  mention: true,
  count: 2,
  revision: 1,
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    banner,
    depth: 0,
    behind: 0,
    behindMentions: 0,
    onopen: vi.fn(),
    ondismiss: vi.fn(),
    onexpand: vi.fn(),
    onreply: vi.fn().mockResolvedValue(undefined),
    onengage: vi.fn(),
    ...overrides,
  };
}

test('tapping the banner opens the room and the close button dismisses it', async () => {
  const handlers = props();
  const screen = await render(InAppBanner, handlers);

  await screen.getByText('Bob: hello').click();
  expect(handlers.onopen).toHaveBeenCalledOnce();

  await screen.getByRole('button', { name: 'Dismiss' }).click();
  expect(handlers.ondismiss).toHaveBeenCalledOnce();
});

test('a custom emote shows as its image', async () => {
  core.fetchMedia.mockResolvedValue(
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYFvXsPwAGNgLW0emd+QAAAABJRU5ErkJggg=='
      ),
      (char) => char.charCodeAt(0)
    )
  );
  const screen = await render(
    InAppBanner,
    props({
      banner: {
        ...banner,
        body: 'Bob: hi :blob:',
        segments: ['Bob: hi ', { alt: ':blob:', source: 'mxc://example.org/blob' }],
      },
    })
  );

  await expect.element(screen.getByRole('img', { name: ':blob:' })).toBeVisible();
  await expect.element(screen.getByText('Bob: hi')).toBeVisible();
});

test('a quick reply sends the typed text', async () => {
  const handlers = props();
  const screen = await render(InAppBanner, handlers);

  await screen.getByRole('button', { name: 'Reply' }).click();
  const input = screen.getByRole('textbox', { name: 'Reply to Room' });
  await expect.element(input).toHaveFocus();
  await userEvent.type(input, 'on my way{Enter}');

  expect(handlers.onreply).toHaveBeenCalledExactlyOnceWith('on my way');
  expect(handlers.onopen).not.toHaveBeenCalled();
});

test('a failed reply keeps the draft and says so on the banner', async () => {
  const handlers = props({ onreply: vi.fn().mockRejectedValue(new Error('offline')) });
  const screen = await render(InAppBanner, handlers);

  await screen.getByRole('button', { name: 'Reply' }).click();
  const input = screen.getByRole('textbox', { name: 'Reply to Room' });
  await userEvent.type(input, 'hi{Enter}');

  await expect.element(screen.getByRole('alert')).toHaveTextContent('Reply not sent. Try again.');
  await expect.element(input).toHaveValue('hi');
});

test('the front banner offers to expand the banners behind it', async () => {
  const handlers = props({ behind: 2, behindMentions: 1 });
  const screen = await render(InAppBanner, handlers);

  await screen.getByRole('button', { name: '2 more conversations · 1 mention' }).click();
  expect(handlers.onexpand).toHaveBeenCalledOnce();
});

function drag(target: Element, dx: number, dy: number): void {
  const box = target.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const at = (type: string, offsetX: number, offsetY: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x + offsetX,
        clientY: y + offsetY,
      })
    );
  at('pointerdown', 0, 0);
  at('pointermove', dx / 2, dy / 2);
  at('pointermove', dx, dy);
  at('pointerup', dx, dy);
}

test.each([
  ['sideways', 200, 0],
  ['up', 0, -80],
])('swiping %s dismisses without opening', async (_, dx, dy) => {
  const handlers = props();
  const screen = await render(InAppBanner, handlers);

  drag(screen.getByText('Bob: hello').element(), dx, dy);

  expect(handlers.ondismiss).toHaveBeenCalledOnce();
  expect(handlers.onopen).not.toHaveBeenCalled();
});

test('a short drag springs back and the next tap still opens', async () => {
  const handlers = props();
  const screen = await render(InAppBanner, handlers);

  drag(screen.getByText('Bob: hello').element(), 30, 0);
  expect(handlers.ondismiss).not.toHaveBeenCalled();

  await screen.getByText('Bob: hello').click();
  expect(handlers.onopen).toHaveBeenCalledOnce();
});
