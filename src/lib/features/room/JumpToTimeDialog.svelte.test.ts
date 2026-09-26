// @vitest-environment happy-dom

import { flushSync, mount, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import JumpToTimeDialog from './JumpToTimeDialog.svelte';

vi.mock('#lib/core/context.js');

const core = Object.assign(baseCore, {
  timestampToEvent: vi.fn<(...args: never[]) => Promise<string | null>>(() =>
    Promise.resolve('$found')
  ),
});

afterEach(() => {
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
  document.body.replaceChildren();
});

test('shows the moment in the reader format and jumps on Enter', async () => {
  preferences.dateFormat = 'ymd';
  preferences.hour24Clock = true;
  const onJump = vi.fn();
  mount(JumpToTimeDialog, {
    target: document.body,
    props: { open: true, roomId: '!r:x', onOpenChange: vi.fn(), onJump },
  });
  await tick();
  flushSync();

  const segments = [...document.querySelectorAll('[data-segment]')];
  expect(segments.slice(0, 5).map((segment) => segment.getAttribute('data-segment'))).toEqual([
    'year',
    'literal',
    'month',
    'literal',
    'day',
  ]);
  expect(document.querySelector('[data-segment="dayPeriod"]')).toBeNull();

  document
    .querySelector('.shortcuts button')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
  document
    .querySelector('[data-segment="day"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  await vi.waitFor(() => {
    expect(onJump).toHaveBeenCalledWith('$found');
  });
  expect(core.timestampToEvent).toHaveBeenCalledWith('!r:x', midnight.getTime(), 'forward');
});
