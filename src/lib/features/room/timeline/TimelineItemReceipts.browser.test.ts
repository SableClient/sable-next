import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';

afterEach(async () => {
  await page.viewport(414, 800);
});

const WRAPPED = `Receipted ${'and wrapped '.repeat(12)}`;
const TWO_READERS = ['@bob:example.test', '@carol:example.test'];
const FOUR_READERS = [...TWO_READERS, '@dave:example.test', '@erin:example.test'];

function item(id: string, body: string, patch: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender: '@bob:example.test',
    sender_name: 'Bob',
    sender_avatar: null,
    timestamp: 1_700_000_000_000,
    content: {
      kind: 'message',
      body,
      html: body,
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
    ...patch,
  };
}

async function mountItem(
  view: TimelineItemView,
  props: { layout?: 'modern' | 'compact' | 'bubble'; alignOwn?: boolean } = {}
) {
  Object.assign(core, { userProfile: vi.fn().mockRejectedValue(new Error('no profile')) });
  const screen = await render(TimelineItemHarness, {
    core,
    item: { item: view, collapsed: false, ...props },
  });
  screen.container.dataset.itemId = view.id;
  if (view.read_by.length === 0) return screen;
  await vi.waitFor(() => {
    expect(
      document.querySelector(`[data-item-id="${view.id}"] .read-receipt-stack`)
    ).not.toBeNull();
  });
  await settled(view.id);
  return screen;
}

async function settled(itemId: string): Promise<void> {
  const height = () =>
    document.querySelector(`[data-item-id="${itemId}"] .message`)?.getBoundingClientRect().height;
  let previous = Number.NaN;
  let steady = 0;
  while (steady < 5) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const current = height();
    steady = current === previous ? steady + 1 : 0;
    previous = current ?? Number.NaN;
  }
}

interface RowBox {
  badge: { top: number; bottom: number; left: number; right: number; height: number };
  body: { bottom: number; right: number };
  lastLine: { right: number };
  time: { right: number } | null;
  content: { right: number; bottom: number };
}

function measure(itemId: string): RowBox {
  const row = document.querySelector(`[data-item-id="${itemId}"]`);
  if (!row) throw new Error(`no rendered row for ${itemId}`);
  const content = row.querySelector('.message-content');
  const body = row.querySelector('.formatted-body');
  const badge = row.querySelector('.read-receipt-stack');
  const time = row.querySelector('header time');
  if (!content || !body || !badge) throw new Error(`row ${itemId} has no receipt layout`);
  const box = (element: Element) => element.getBoundingClientRect();
  return {
    badge: {
      top: box(badge).top,
      bottom: box(badge).bottom,
      left: box(badge).left,
      right: box(badge).right,
      height: box(badge).height,
    },
    body: { bottom: box(body).bottom, right: box(body).right },
    lastLine: { right: [...body.getClientRects()].at(-1)?.right ?? box(body).right },
    time: time ? { right: box(time).right } : null,
    content: { right: box(content).right, bottom: box(content).bottom },
  };
}

function lineCount(itemId: string): number {
  const body = document.querySelector(`[data-item-id="${itemId}"] .formatted-body`);
  if (!body) throw new Error('no body');
  const range = document.createRange();
  range.selectNodeContents(body);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

for (const layout of ['bubble', 'compact'] as const) {
  test(`the ${layout} layout keeps the badge beside the last line`, async () => {
    await page.viewport(390, 780);
    await mountItem(item('receipted', WRAPPED, { read_by: TWO_READERS }), { layout });

    const receipted = measure('receipted');
    expect(Math.abs(receipted.badge.right - receipted.content.right)).toBeLessThanOrEqual(1);
    expect(receipted.lastLine.right).toBeLessThanOrEqual(receipted.badge.left);
    expect(Math.abs(receipted.badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
    expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);
  });
}

test('a receipt badge sits beside the last line and leaves the timestamp on the right', async () => {
  await page.viewport(390, 780);
  await mountItem(item('plain', WRAPPED));
  const plain = document.querySelector('[data-item-id="plain"] header time');
  expect(document.querySelector('[data-item-id="plain"] .read-receipt-stack')).toBeNull();
  const plainRight = plain?.getBoundingClientRect().right;

  await mountItem(item('receipted', WRAPPED, { read_by: FOUR_READERS }));
  const receipted = measure('receipted');

  expect(receipted.badge.height).toBeGreaterThan(0);
  expect(Math.abs(receipted.badge.right - receipted.content.right)).toBeLessThanOrEqual(1);
  expect(receipted.lastLine.right).toBeLessThanOrEqual(receipted.badge.left);
  if (plainRight !== undefined && receipted.time) {
    expect(Math.abs(receipted.time.right - plainRight)).toBeLessThanOrEqual(1);
  }
  expect(receipted.badge.top).toBeLessThan(receipted.body.bottom);
  expect(Math.abs(receipted.badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);

  const overflow = document.querySelector<HTMLElement>(
    '[data-item-id="receipted"] .read-receipt-stack .overflow'
  );
  if (!overflow) throw new Error('no overflow control');
  const box = overflow.getBoundingClientRect();
  const after = getComputedStyle(overflow, '::after');
  expect(
    box.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom)
  ).toBeGreaterThanOrEqual(28);
});

test('an emote-only message keeps the badge on its bottom edge', async () => {
  await page.viewport(390, 780);
  const base = item('receipted', ':party:');
  await mountItem({
    ...base,
    content: {
      ...base.content,
      html: '<img src="mxc://example.test/emote" alt=":party:" title=":party:" />',
    } as TimelineItemView['content'],
    read_by: TWO_READERS,
  });

  const receipted = measure('receipted');
  expect(Math.abs(receipted.badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.badge.height).toBeLessThanOrEqual(30);
});

test('a short receipted bubble keeps its text on one line', async () => {
  await page.viewport(390, 780);
  await mountItem(item('receipted', 'miam miam', { read_by: TWO_READERS }), { layout: 'bubble' });
  await mountItem(item('own-receipted', 'miam miam', { is_own: true, read_by: TWO_READERS }), {
    layout: 'bubble',
  });

  for (const id of ['receipted', 'own-receipted']) {
    const receipted = measure(id);
    expect(lineCount(id)).toBe(1);
    expect(receipted.lastLine.right).toBeLessThanOrEqual(receipted.badge.left);
  }
});

test('a short receipted notice keeps its text on one line', async () => {
  await page.viewport(390, 780);
  const base = item('receipted-notice', 'miam miam');
  await mountItem(
    {
      ...base,
      content: {
        ...base.content,
        html: '<p>miam miam</p>',
        notice: true,
      } as TimelineItemView['content'],
      read_by: TWO_READERS,
    },
    { layout: 'bubble' }
  );

  const receipted = measure('receipted-notice');
  expect(lineCount('receipted-notice')).toBe(1);
  expect(Math.abs(receipted.badge.bottom - receipted.content.bottom)).toBeLessThanOrEqual(1);
  expect(receipted.content.bottom - receipted.body.bottom).toBeLessThanOrEqual(2);
});

for (const alignOwn of [true, false]) {
  test(`a long receipted bubble is no wider than its box (align own: ${String(alignOwn)})`, async () => {
    await page.viewport(1600, 900);
    const long = 'long message that goes on and on '.repeat(60);
    await mountItem(item('own-long', long, { is_own: true, read_by: TWO_READERS }), {
      layout: 'bubble',
      alignOwn,
    });

    const row = document.querySelector('[data-item-id="own-long"]');
    const body = row?.querySelector('.formatted-body')?.getBoundingClientRect();
    const wrapper = row?.querySelector('.has-receipts')?.getBoundingClientRect();
    if (!body || !wrapper) throw new Error('no box');
    expect(Math.round(wrapper.right) - Math.round(wrapper.left)).toBeLessThanOrEqual(
      Math.round(body.right) - Math.round(body.left) + 60
    );
  });
}

test('own trailing reactions clear a wide receipt stack', async () => {
  await page.viewport(500, 800);
  await mountItem(
    item('own-reacted', 'hello there', {
      is_own: true,
      reactions: [{ key: '👍', senders: ['@bob:example.test'] }] as TimelineItemView['reactions'],
      read_by: FOUR_READERS,
    }),
    { layout: 'bubble' }
  );

  const row = document.querySelector('[data-item-id="own-reacted"]');
  await vi.waitFor(() => {
    const reactions = row?.querySelector('.reactions')?.getBoundingClientRect();
    const badge = row?.querySelector('.read-receipt-stack')?.getBoundingClientRect();
    if (!reactions || !badge) throw new Error('layout not ready');
    expect(badge.x - (reactions.x + reactions.width)).toBeGreaterThanOrEqual(0);
  });
});

test('a receipt never takes a line of its own or covers text when the last line is full', async () => {
  await page.viewport(1280, 720);
  for (const unit of ['word ', 'adsf']) {
    for (let length = 60; length <= 140; length += 1) {
      const body = unit.repeat(40).slice(0, length).trim();
      const screen = await mountItem(item('general-18', body, { read_by: ['@bob:example.test'] }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const row = document.querySelector('[data-item-id="general-18"] .message');
      const text = row?.querySelector('.formatted-body');
      const badge = row?.querySelector('.read-receipt-stack');
      if (!text || !badge) throw new Error('missing body or badge');
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const badgeBox = badge.getBoundingClientRect();
      const last = lines.at(-1);
      const label = `${unit.trim()} x ${String(length)}`;
      expect(last ? badgeBox.top - last.bottom : Number.POSITIVE_INFINITY, label).toBeLessThan(0);
      expect(
        lines.some(
          (rect) =>
            rect.right > badgeBox.left + 0.5 &&
            rect.left < badgeBox.right - 0.5 &&
            rect.bottom > badgeBox.top + 0.5 &&
            rect.top < badgeBox.bottom - 0.5
        ),
        label
      ).toBe(false);
      await screen.unmount();
    }
  }
}, 120_000);
