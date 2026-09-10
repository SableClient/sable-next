// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import * as fakeHistory from './overlay-back-history.test.svelte.js';

vi.mock('$app/navigation', () => ({ goto: fakeHistory.goto }));
vi.mock('$app/state', () => ({ page: fakeHistory.pageStub }));

import Harness from './OverlayBackHarness.test.svelte';

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
  await Promise.resolve();
  await tick();
}

beforeEach(() => {
  fakeHistory.reset();
  vi.spyOn(window.history, 'go').mockImplementation(fakeHistory.go);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('an open overlay holds one history entry', async () => {
  const onClose = vi.fn();
  const component = mount(Harness, { target: document.body, props: { open: true, onClose } });
  await settle();

  expect(fakeHistory.entries()).toBe(2);
  expect(fakeHistory.pageStub.state.overlay).toBe(1);
  expect(onClose).not.toHaveBeenCalled();

  void unmount(component);
});

test('a back press closes the overlay rather than leaving the page', async () => {
  const onClose = vi.fn();
  const component = mount(Harness, { target: document.body, props: { open: true, onClose } });
  await settle();

  fakeHistory.go(-1);
  await settle();

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fakeHistory.entries()).toBe(1);

  void unmount(component);
});

test('back unwinds one level at a time when a second level is held', async () => {
  const onClose = vi.fn();
  const onCloseNested = vi.fn();
  const component = mount(Harness, {
    target: document.body,
    props: { open: true, nested: true, onClose, onCloseNested },
  });
  await settle();

  expect(fakeHistory.pageStub.state.overlay).toBe(2);

  fakeHistory.go(-1);
  await settle();

  expect(onCloseNested).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(fakeHistory.entries()).toBe(2);

  void unmount(component);
});

test('closing from inside pops the entries it pushed, and no more', async () => {
  const onClose = vi.fn();
  const component = mount(Harness, {
    target: document.body,
    props: { open: true, nested: true, onClose },
  });
  await settle();
  expect(fakeHistory.entries()).toBe(3);

  void unmount(component);
  await settle();

  expect(fakeHistory.entries()).toBe(1);
});
