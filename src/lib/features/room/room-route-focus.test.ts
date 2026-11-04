// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/ui/app-layout.svelte.js', () => ({ matchesAppLayout: vi.fn(() => true) }));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => roomId,
  findRoomByPathId: () => undefined,
}));

import { afterNavigate, beforeNavigate } from '#lib/test-support/app-navigation.js';
import { matchesAppLayout } from '#lib/ui/app-layout.svelte.js';

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
    vi.mocked(matchesAppLayout).mockReturnValue(true);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      setTimeout(callback, 0);
    });
    document.body.innerHTML = `
      <div data-focus-region="rooms"><a href="#r" role="treeitem" id="item">Room</a></div>
      <h1 tabindex="-1" data-room-heading id="heading">Room</h1>
      <div data-focus-region="composer"><div contenteditable="true" id="composer"></div></div>
      <div role="dialog"><input id="palette" /></div>`;
  });

  test('opening a room from the list focuses its composer', () => {
    const { before, after } = routeFocus();
    const item = document.getElementById('item') as HTMLElement;
    item.focus();
    before();

    after('/rooms/room');

    expect(document.activeElement?.id).toBe('composer');
  });

  test('opening a room on mobile keeps focus in the list', () => {
    vi.mocked(matchesAppLayout).mockReturnValue(false);
    const { before, after } = routeFocus();
    const item = document.getElementById('item') as HTMLElement;
    item.focus();
    before();
    item.blur();

    after('/rooms/room');

    expect(document.activeElement).toBe(item);
  });

  test('waits for the composer to mount', async () => {
    const { before, after } = routeFocus();
    const composer = document.getElementById('composer') as HTMLElement;
    const container = composer.parentElement as HTMLElement;
    composer.remove();
    document.getElementById('item')?.focus();
    before();
    after('/rooms/room');

    container.append(composer);

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
  });

  test('does not take focus if the user moves elsewhere while the composer loads', async () => {
    const { before, after } = routeFocus();
    const composer = document.getElementById('composer') as HTMLElement;
    const container = composer.parentElement as HTMLElement;
    composer.remove();
    document.getElementById('item')?.focus();
    before();
    after('/rooms/room');

    document.getElementById('palette')?.focus();
    container.append(composer);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement?.id).toBe('palette');
  });

  test('cancels pending composer focus when another navigation starts', async () => {
    const { before, after } = routeFocus();
    const composer = document.getElementById('composer') as HTMLElement;
    const container = composer.parentElement as HTMLElement;
    composer.remove();
    document.getElementById('item')?.focus();
    before();
    after('/rooms/room');

    before();
    after('/settings');
    container.append(composer);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement?.id).toBe('item');
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

  test('focus in a dialog input that closes with the navigation moves to the room heading', () => {
    const { before, after } = routeFocus();
    const input = document.getElementById('palette') as HTMLElement;
    input.focus();
    before();
    input.blur();

    after('/rooms/room');

    expect(document.activeElement?.id).toBe('heading');
  });

  test('a route that is not a room does not move focus', () => {
    const { before, after } = routeFocus();
    before();

    after('/settings');

    expect(document.activeElement).toBe(document.body);
  });
});
