import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoomRulesView } from '#src/generated/protocol';

import { RoomRules } from './room-rules.svelte';

let spaces = 0;

function view(overrides: Partial<RoomRulesView> = {}): RoomRulesView {
  return {
    source_room_id: `!space${spaces}:example.org`,
    html: 'Be kind',
    version: 2,
    require_acceptance: true,
    accepted: false,
    updated_at: null,
    ...overrides,
  };
}

// Dismissals outlive a store, so each test reads the rules of its own space.
beforeEach(() => {
  spaces += 1;
});

function rulesFor(...views: (RoomRulesView | null | Error)[]) {
  const rules = vi.fn();
  for (const next of views) {
    if (next instanceof Error) rules.mockRejectedValueOnce(next);
    else rules.mockResolvedValueOnce(next);
  }
  const acceptRules = vi.fn().mockResolvedValue(null);
  return { store: new RoomRules({ room_state: { rules, acceptRules } }), rules, acceptRules };
}

describe('RoomRules', () => {
  it('locks the room only for unaccepted rules that require acceptance', async () => {
    const cases = [view(), view({ accepted: true }), view({ require_acceptance: false }), null];
    const locked = [];
    for (const next of cases) {
      const { store } = rulesFor(next);
      await store.load('!room:example.org');
      locked.push(store.blocking);
    }

    expect(locked).toEqual([true, false, false, false]);
  });

  it('records acceptance on the room the rules come from', async () => {
    const { store, acceptRules } = rulesFor(view());
    await store.load('!room:example.org');

    await store.accept();

    expect(acceptRules).toHaveBeenCalledWith({ room_id: view().source_room_id, version: 2 });
    expect(store.blocking).toBe(false);
    expect(store.visible).toBe(false);
  });

  it('stays unlocked when a reload beats the acceptance echo', async () => {
    const { store } = rulesFor(view(), view());
    await store.load('!room:example.org');
    await store.accept();

    await store.load('!room:example.org');

    expect(store.blocking).toBe(false);
  });

  it('keeps the rules as read when they change under the reader, and accepts nothing until reviewed', async () => {
    const { store, acceptRules } = rulesFor(view(), view({ version: 3, html: 'Be kinder' }));
    await store.load('!room:example.org');
    await store.load('!room:example.org');

    expect(store.shown?.html).toBe('Be kind');
    expect(store.stale).toBe(true);
    await store.accept();
    expect(acceptRules).not.toHaveBeenCalled();

    store.review();
    expect(store.shown?.html).toBe('Be kinder');
    await store.accept();
    expect(acceptRules).toHaveBeenCalledWith({ room_id: view().source_room_id, version: 3 });
  });

  it('says so when the rules on screen are removed, instead of closing', async () => {
    const { store, acceptRules } = rulesFor(view(), null);
    await store.load('!room:example.org');
    await store.load('!room:example.org');

    expect(store.visible).toBe(true);
    expect(store.removed).toBe(true);
    expect(store.blocking).toBe(false);
    await store.accept();
    expect(acceptRules).not.toHaveBeenCalled();

    store.dismiss();
    expect(store.visible).toBe(false);
    expect(store.shown).toBeNull();
  });

  it('follows the latest rules while nothing is on screen', async () => {
    const { store } = rulesFor(
      view({ accepted: true }),
      view({ accepted: true, version: 3, html: 'Be kinder' })
    );
    await store.load('!room:example.org');
    await store.load('!room:example.org');

    expect(store.shown?.html).toBe('Be kinder');
    expect(store.stale).toBe(false);
  });

  it('prompts once per session for a version, across the rooms that share the rules', async () => {
    const { store } = rulesFor(view(), view(), view({ version: 3 }));
    await store.load('!room:example.org');
    expect(store.prompting).toBe(true);

    store.dismiss();
    expect(store.visible).toBe(false);
    expect(store.blocking).toBe(true);

    await store.load('!other:example.org');
    expect(store.prompting).toBe(false);

    await store.load('!other:example.org');
    expect(store.prompting).toBe(true);
  });

  it('opens on demand after a dismissal', async () => {
    const { store } = rulesFor(view());
    await store.load('!room:example.org');
    store.dismiss();

    store.open = true;

    expect(store.visible).toBe(true);
  });

  it('retries a failed load only', async () => {
    const { store, rules } = rulesFor(new Error('offline'), view(), view());
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    await store.load('!room:example.org');
    expect(store.blocking).toBe(false);

    store.retry();
    await vi.waitFor(() => {
      expect(store.blocking).toBe(true);
    });

    store.retry();
    expect(rules).toHaveBeenCalledTimes(2);
  });
});
