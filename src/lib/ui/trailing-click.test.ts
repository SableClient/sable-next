import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { armTrailingClickSwallow, guardTouchClicks } from './trailing-click.js';

let stopGuard: (() => void) | undefined;
let item: HTMLButtonElement;
let activated: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  activated = vi.fn(() => {});
  item = document.createElement('button');
  item.addEventListener('click', activated);
  document.body.append(item);
});

afterEach(() => {
  stopGuard?.();
  stopGuard = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function press(pointerType: string, target: HTMLElement = item): void {
  const down = new MouseEvent('pointerdown', { bubbles: true });
  Object.defineProperty(down, 'pointerType', { value: pointerType });
  target.dispatchEvent(down);
}

function lift(target: HTMLElement = item): void {
  target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
}

function surface(): { element: HTMLButtonElement; activated: () => void } {
  const element = document.createElement('button');
  const spy = vi.fn(() => {});
  element.addEventListener('click', spy);
  document.body.append(element);
  return { element, activated: spy };
}

test('a click retargeted onto a surface that mounted under the finger is swallowed', () => {
  stopGuard = guardTouchClicks();

  press('touch');
  const sheet = surface();
  lift();
  sheet.element.click();

  expect(sheet.activated).not.toHaveBeenCalled();
});

test('a touch that lifts on what it pressed still activates it', () => {
  stopGuard = guardTouchClicks();

  press('touch');
  lift();
  item.click();

  expect(activated).toHaveBeenCalledOnce();
});

test('a mouse press is never second-guessed', () => {
  stopGuard = guardTouchClicks();

  press('mouse');
  const menu = surface();
  menu.element.click();

  expect(menu.activated).toHaveBeenCalledOnce();
});

test('a touch context menu swallows the click its own lift produces', () => {
  stopGuard = guardTouchClicks();

  press('touch');
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  lift();
  item.click();

  expect(activated).not.toHaveBeenCalled();

  item.click();
  expect(activated).toHaveBeenCalledOnce();
});

test('an armed swallow that no click follows expires after the lift', () => {
  stopGuard = guardTouchClicks();

  armTrailingClickSwallow();
  lift();
  vi.advanceTimersByTime(500);
  item.click();

  expect(activated).toHaveBeenCalledOnce();
});

test('the swallow only expires once the pointer is up', () => {
  stopGuard = guardTouchClicks();

  armTrailingClickSwallow();
  vi.advanceTimersByTime(5000);
  item.click();

  expect(activated).not.toHaveBeenCalled();
});

test('a lost lift cannot leave the swallow armed across the next tap', () => {
  stopGuard = guardTouchClicks();

  press('touch');
  armTrailingClickSwallow();
  press('touch');
  lift();
  item.click();

  expect(activated).toHaveBeenCalledOnce();
});

test('a touch that produces no click is not compared against a later one', () => {
  stopGuard = guardTouchClicks();

  press('touch');
  lift();
  vi.advanceTimersByTime(500);
  const menu = surface();
  menu.element.click();

  expect(menu.activated).toHaveBeenCalledOnce();
});

test('the teardown drops the guard', () => {
  guardTouchClicks()();

  press('touch');
  const sheet = surface();
  lift();
  sheet.element.click();

  expect(sheet.activated).toHaveBeenCalledOnce();
});
