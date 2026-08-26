import { beforeEach, expect, test, vi } from 'vitest';

import { editThreshold, replyThreshold } from './message-swipe';
import { MessageSwipe } from './message-swipe.svelte.js';

const WIDTH = 800;
const PAST_REPLY = replyThreshold(WIDTH) + 10;
const PAST_EDIT = editThreshold(WIDTH, true) + 10;

let node: HTMLElement;

beforeEach(() => {
  node = document.createElement('div');
  Object.defineProperty(node, 'clientWidth', { value: WIDTH, configurable: true });
  document.body.append(node);
});

function fire(type: string, x: number, y = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: touches });
  node.dispatchEvent(event);
  return event;
}

async function harness(overrides: { enabled?: boolean; canEdit?: boolean } = {}) {
  const onReply = vi.fn();
  const onEdit = vi.fn();
  const swipe = new MessageSwipe({
    enabled: () => overrides.enabled ?? true,
    canEdit: () => overrides.canEdit ?? false,
    onReply,
    onEdit,
  });
  const detach = swipe.attach(node);
  await Promise.resolve();

  return { swipe, onReply, onEdit, detach };
}

test('a leftward drag past the threshold replies on release', async () => {
  const { swipe, onReply } = await harness();

  fire('touchstart', 0);
  const moved = fire('touchmove', -PAST_REPLY);

  expect(moved.defaultPrevented).toBe(true);
  expect(swipe.action).toBe('reply');
  expect(swipe.offset).toBeGreaterThan(0);
  expect(swipe.dragging).toBe(true);

  fire('touchend', 0);

  expect(onReply).toHaveBeenCalledOnce();
  expect(swipe.offset).toBe(0);
  expect(swipe.action).toBe('none');
});

test('a drag that stops short of the threshold does not reply', async () => {
  const { swipe, onReply } = await harness();

  fire('touchstart', 0);
  fire('touchmove', -12);
  fire('touchend', 0);

  expect(onReply).not.toHaveBeenCalled();
  expect(swipe.offset).toBe(0);
});

test('a rightward drag is left to the nav drawer', async () => {
  const { swipe, onReply } = await harness();

  fire('touchstart', 0);
  const moved = fire('touchmove', PAST_REPLY);

  expect(swipe.offset).toBe(0);
  expect(swipe.action).toBe('none');
  expect(moved.defaultPrevented).toBe(false);

  fire('touchend', 0);
  expect(onReply).not.toHaveBeenCalled();
});

test('a vertical drag never swipes, even if it later turns sideways', async () => {
  const { swipe, onReply } = await harness();

  fire('touchstart', 0, 0);
  fire('touchmove', -2, -40);
  fire('touchmove', -PAST_REPLY, -40);

  expect(swipe.offset).toBe(0);

  fire('touchend', 0);
  expect(onReply).not.toHaveBeenCalled();
});

test('a cancelled gesture commits nothing', async () => {
  const { swipe, onReply } = await harness();

  fire('touchstart', 0);
  fire('touchmove', -PAST_REPLY);
  fire('touchcancel', 0);

  expect(onReply).not.toHaveBeenCalled();
  expect(swipe.offset).toBe(0);
});

test('a deep drag edits instead of replying, but only where editing is allowed', async () => {
  const editable = await harness({ canEdit: true });

  fire('touchstart', 0);
  fire('touchmove', -PAST_EDIT);
  expect(editable.swipe.action).toBe('edit');
  fire('touchend', 0);

  expect(editable.onEdit).toHaveBeenCalledOnce();
  expect(editable.onReply).not.toHaveBeenCalled();
  editable.detach();

  const readOnly = await harness({ canEdit: false });

  fire('touchstart', 0);
  fire('touchmove', -PAST_EDIT);
  fire('touchend', 0);

  expect(readOnly.onEdit).not.toHaveBeenCalled();
  expect(readOnly.onReply).toHaveBeenCalledOnce();
});

test('a message with no reply action never moves', async () => {
  const { swipe, onReply } = await harness({ enabled: false });

  fire('touchstart', 0);
  fire('touchmove', -PAST_REPLY);
  fire('touchend', 0);

  expect(swipe.offset).toBe(0);
  expect(onReply).not.toHaveBeenCalled();
});

test('a gesture starting in a scrollable code block does not swipe', async () => {
  const { swipe, onReply } = await harness();
  const code = document.createElement('pre');
  Object.defineProperty(code, 'scrollWidth', { value: 900, configurable: true });
  Object.defineProperty(code, 'clientWidth', { value: 300, configurable: true });
  node.append(code);

  const start = new Event('touchstart', { bubbles: true });
  Object.defineProperty(start, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
  code.dispatchEvent(start);
  fire('touchmove', -PAST_REPLY);
  fire('touchend', 0);

  expect(swipe.offset).toBe(0);
  expect(onReply).not.toHaveBeenCalled();
});

test('detaching stops the gesture from firing', async () => {
  const { onReply, detach } = await harness();

  detach();
  fire('touchstart', 0);
  fire('touchmove', -PAST_REPLY);
  fire('touchend', 0);

  expect(onReply).not.toHaveBeenCalled();
});
