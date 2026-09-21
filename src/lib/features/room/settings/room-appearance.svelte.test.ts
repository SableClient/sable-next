import { describe, expect, test } from 'vitest';

import { parseRoomIconOverrides, showsRoomAvatar } from './room-appearance.svelte.js';

describe('room icon appearance', () => {
  test('matches the v1 room-icon modes', () => {
    expect(showsRoomAvatar('always', false, false)).toBe(true);
    expect(showsRoomAvatar('sometimes', false, true)).toBe(true);
    expect(showsRoomAvatar('sometimes', false, false)).toBe(false);
    expect(showsRoomAvatar('sometimes', true, false)).toBe(true);
    expect(showsRoomAvatar('collapsed', false, true)).toBe(false);
    expect(showsRoomAvatar('collapsed', true, false)).toBe(true);
    expect(showsRoomAvatar('never', true, true)).toBe(false);
  });

  test('keeps the sometimes per-space override', () => {
    expect(parseRoomIconOverrides({ '!space:example.org': 'sometimes' })).toEqual([
      ['!space:example.org', 'sometimes'],
    ]);
  });
});
