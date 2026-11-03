// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => roomId,
  findRoomByPathId: () => undefined,
}));

import { afterNavigate, beforeNavigate } from '#lib/test-support/app-navigation.js';

import { trackRouteFocus } from './room-navigation';

function routeFocus(): { before: () => void; after: (to: string) => void } {
  trackRouteFocus();
  const before = beforeNavigate.mock.calls.at(-1)?.[0] as () => void;
  const after = afterNavigate.mock.calls.at(-1)?.[0] as (navigation: unknown) => void;
  return {
    before,
    after: (to) => {
      after({ from: null, to: { url: new URL(`https://app.test${to}`) } });
    },
  };
}

describe('focus after a route change', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      setTimeout(callback, 0);
    });
    document.body.innerHTML = `
      <div data-focus-region="rooms"><a href="#r" role="treeitem" id="item">Room</a></div>
      <h1 tabindex="-1" data-room-heading id="heading">Room</h1>
      <div contenteditable="true" id="composer"></div>`;
  });

  test('focus that was on a room list item returns to it after the browser blurs it', () => {
    const { before, after } = routeFocus();
    const item = document.getElementById('item') as HTMLElement;
    item.focus();
    before();
    item.blur();

    after('/rooms/room');

    expect(document.activeElement).toBe(item);
  });

  test('focus lost to the body moves to the room heading', () => {
    const { before, after } = routeFocus();
    before();

    after('/rooms/room');

    expect(document.activeElement?.id).toBe('heading');
  });

  test('focus in the composer is not taken', () => {
    const { before, after } = routeFocus();
    const composer = document.getElementById('composer') as HTMLElement;
    composer.focus();
    before();
    composer.blur();

    after('/rooms/room');

    expect(document.activeElement).toBe(document.body);
    expect(document.getElementById('heading')?.matches(':focus')).toBe(false);
  });

  test('a route that is not a room does not move focus', () => {
    const { before, after } = routeFocus();
    before();

    after('/settings');

    expect(document.activeElement).toBe(document.body);
  });
});
