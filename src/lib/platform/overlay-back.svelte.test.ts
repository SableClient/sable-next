// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import * as fakeHistory from './overlay-back-history.test.svelte.js';

vi.mock('$app/navigation', () => ({ goto: fakeHistory.goto }));
vi.mock('$app/state', () => ({ page: fakeHistory.pageStub }));

const guard = vi.hoisted(() => ({
  leave: vi.fn<(proceed: () => void, stay?: () => void) => void>((proceed) => {
    proceed();
  }),
}));

vi.mock('#lib/ui/unsaved-guard.js', () => ({ leaveUnlessUnsaved: guard.leave }));

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
  vi.restoreAllMocks();
  guard.leave.mockImplementation((proceed) => {
    proceed();
  });
});

test('an open overlay holds one history entry', async () => {
  const onClose = vi.fn();
  render(Harness, { props: { open: true, onClose } });
  await settle();

  expect(fakeHistory.entries()).toBe(2);
  expect(fakeHistory.pageStub.state.overlay).toBe(1);
  expect(onClose).not.toHaveBeenCalled();
});

test('a back press closes the overlay rather than leaving the page', async () => {
  const onClose = vi.fn();
  render(Harness, { props: { open: true, onClose } });
  await settle();

  fakeHistory.go(-1);
  await settle();

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fakeHistory.entries()).toBe(1);
});

test('navigating to another page while an overlay is open does not close it', async () => {
  const onClose = vi.fn();
  render(Harness, { props: { open: true, onClose } });
  await settle();

  fakeHistory.navigate('/rooms/restored');
  await settle();

  expect(onClose).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(fakeHistory.pageStub.state.overlay).toBe(1);
  });

  fakeHistory.go(-1);
  await settle();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('back unwinds one level at a time when a second level is held', async () => {
  const onClose = vi.fn();
  const onCloseNested = vi.fn();
  render(Harness, {
    props: { open: true, nested: true, onClose, onCloseNested },
  });
  await settle();

  expect(fakeHistory.pageStub.state.overlay).toBe(2);

  fakeHistory.go(-1);
  await settle();

  expect(onCloseNested).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(fakeHistory.entries()).toBe(2);
});

test('closing from inside pops the entries it pushed, and no more', async () => {
  const onClose = vi.fn();
  const component = render(Harness, {
    props: { open: true, nested: true, onClose },
  });
  await settle();
  expect(fakeHistory.entries()).toBe(3);

  component.unmount();
  await settle();

  expect(fakeHistory.entries()).toBe(1);
});

test('closing a lower overlay leaves the one opened above it open', async () => {
  const lower = render(Harness, { props: { open: true, onClose: vi.fn() } });
  await settle();
  const onCloseUpper = vi.fn();
  render(Harness, { props: { open: true, onClose: onCloseUpper } });
  await settle();

  await lower.rerender({ open: false });
  await settle();

  expect(onCloseUpper).not.toHaveBeenCalled();
  expect(fakeHistory.pageStub.state.overlay).toBe(2);

  fakeHistory.go(-1);
  await settle();

  expect(onCloseUpper).toHaveBeenCalledTimes(1);
  expect(fakeHistory.entries()).toBe(1);
});

test('the top overlay closing from inside also pops a lower one released before it', async () => {
  const lower = render(Harness, { props: { open: true, onClose: vi.fn() } });
  await settle();
  const upper = render(Harness, { props: { open: true, onClose: vi.fn() } });
  await settle();

  await lower.rerender({ open: false });
  await settle();
  await upper.rerender({ open: false });
  await settle();

  expect(fakeHistory.entries()).toBe(1);
});

test('a back press with unsaved changes asks before closing', async () => {
  const asked: { proceed: () => void; stay?: () => void }[] = [];
  guard.leave.mockImplementation((proceed, stay) => {
    asked.push({ proceed, stay });
  });
  const onClose = vi.fn();
  render(Harness, { props: { open: true, onClose } });
  await settle();

  fakeHistory.go(-1);
  await settle();

  expect(onClose).not.toHaveBeenCalled();
  expect(asked).toHaveLength(1);

  asked[0].proceed();
  expect(onClose).toHaveBeenCalledOnce();
});

test('staying after a guarded back press takes the history entry again', async () => {
  const asked: { proceed: () => void; stay?: () => void }[] = [];
  guard.leave.mockImplementation((proceed, stay) => {
    asked.push({ proceed, stay });
  });
  const onClose = vi.fn();
  render(Harness, { props: { open: true, onClose } });
  await settle();

  fakeHistory.go(-1);
  await settle();
  expect(fakeHistory.entries()).toBe(1);

  asked[0].stay?.();
  await vi.waitFor(() => {
    expect(fakeHistory.entries()).toBe(2);
  });
  expect(fakeHistory.pageStub.state.overlay).toBe(1);
  expect(onClose).not.toHaveBeenCalled();

  guard.leave.mockImplementation((proceed) => {
    proceed();
  });
  fakeHistory.go(-1);
  await settle();
  expect(onClose).toHaveBeenCalledOnce();
});
