// @vitest-environment happy-dom
import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, onTestFinished, test, vi } from 'vitest';
import ForumThreadList from './ForumThreadList.svelte';

function noopCallbacks() {
  return { onOpen: vi.fn(), onDelete: vi.fn(), onCopyLink: vi.fn() };
}

test('a failed empty forum offers recovery', async () => {
  const retry = vi.fn();
  render(ForumThreadList, {
    threads: [],
    loading: false,
    failed: true,
    canLoadMore: false,
    onRetry: retry,
    callbacks: noopCallbacks(),
    canDelete: () => false,
    roomId: '!forum:example.org',
    onLoadMore: vi.fn(),
  });
  expect(screen.getByRole('alert')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();
});

const base = {
  threads: [],
  loading: false,
  canLoadMore: false,
  callbacks: noopCallbacks(),
  canDelete: () => false,
  roomId: '!forum:example.org',
  onLoadMore: vi.fn(),
};

test('an empty forum offers to start its first thread', async () => {
  const create = vi.fn();
  render(ForumThreadList, { ...base, onCreate: create });
  expect(document.querySelector('.forum-thread-list-empty')).not.toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'New thread' }));
  expect(create).toHaveBeenCalledOnce();
});

test('a search that misses says so only once every thread is loaded', async () => {
  const { rerender } = render(ForumThreadList, { ...base, filtered: true, canLoadMore: true });
  expect(document.querySelector('.forum-thread-list-empty')).toBeNull();
  await rerender({ canLoadMore: false });
  expect(document.querySelector('.forum-thread-list-empty')).not.toBeNull();
});

test('reaching the end of the list loads older threads', () => {
  const backup = globalThis.IntersectionObserver;
  onTestFinished(() => {
    globalThis.IntersectionObserver = backup;
  });
  const observers: IntersectionObserverCallback[] = [];
  globalThis.IntersectionObserver = class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push(callback);
    }
  } as unknown as typeof IntersectionObserver;
  const loadMore = vi.fn();
  render(ForumThreadList, { ...base, canLoadMore: true, onLoadMore: loadMore });
  expect(loadMore).not.toHaveBeenCalled();

  observers[0]?.(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver
  );

  expect(loadMore).toHaveBeenCalledOnce();
});
