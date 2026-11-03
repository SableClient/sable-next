import { expect, test } from 'vitest';
import type { MemberView } from '#src/generated/protocol';
import { MemberPreviews, type MemberPreview } from './member-previews.svelte.js';

const preview = (): MemberPreview => ({
  key: 'name-asc',
  threshold: 1,
  count: 60,
  groups: [100, 50, 0].map((level) => ({
    key: String(level),
    level,
    tag: { name: String(level), color: null, icon: null },
    members: Array.from(
      { length: 20 },
      (_, i) => ({ user_id: `@${level}-${i}:test` }) as MemberView
    ),
  })),
});

test('keeps 30 rows across eight recent rooms', () => {
  const cache = new MemberPreviews();
  const input = preview();
  cache.set('0', input);
  const saved = cache.get('0', 'name-asc', 1);
  expect(saved?.groups.map((group) => group.members.length)).toEqual([20, 10]);
  expect(saved?.count).toBe(60);
  expect(input.groups[1].members).toHaveLength(20);

  for (let i = 1; i < 8; i++) cache.set(String(i), preview());
  cache.set('0', input);
  cache.set('8', preview());
  expect(cache.get('0', 'name-asc', 1)).not.toBeNull();
  expect(cache.get('1', 'name-asc', 1)).toBeNull();
  expect(cache.get('8', 'name-asc', 1)).not.toBeNull();
});
