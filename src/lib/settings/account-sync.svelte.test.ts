import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreEvent, SealStateView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { clearDraft, clearDrafts, readDraft } from '#lib/composer/composer-drafts.svelte.js';

import { ACCOUNT_DATA_KEY_TYPE, AccountSync, type SyncedDocument } from './account-sync.svelte';
import { draftsDocumentFor } from './sync-documents';

type SealState = SealStateView;

function stubCore(
  remote: Record<string, unknown>,
  sealing: { canSeal: boolean; states: Record<string, SealState> } = { canSeal: false, states: {} }
) {
  const listeners: ((event: CoreEvent) => void)[] = [];
  const core = {
    rpc: {
      account: {
        data: vi.fn(({ event_type }: { event_type: string }) =>
          Promise.resolve(remote[event_type] ?? null)
        ),
        setData: vi.fn(({ event_type, content }: { event_type: string; content: unknown }) => {
          remote[event_type] = content;
          return Promise.resolve(null);
        }),
        sealedData: vi.fn(({ event_type }: { event_type: string }) => {
          const state = sealing.states[event_type] ?? 'plain';
          return Promise.resolve({
            content: state === 'locked' ? null : (remote[event_type] ?? null),
            state,
            can_seal: sealing.canSeal,
          });
        }),
        setSealedData: vi.fn(
          ({ event_type, content }: { event_type: string; content: unknown }) => {
            remote[event_type] = content;
            sealing.states[event_type] = sealing.canSeal ? 'sealed' : 'plain';
            return Promise.resolve(null);
          }
        ),
      },
    },
    subscribeEvents: vi.fn((listener: (event: CoreEvent) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
  };

  return {
    core: core as unknown as CoreClient,
    commands: core.rpc.account,
    announce: (eventType: string): void => {
      for (const listener of listeners) {
        listener({ type: 'account_data_changed', event_type: eventType });
      }
    },
  };
}

function stubDocument(local: { value: string }, overrides: Partial<SyncedDocument> = {}) {
  return {
    eventType: 'moe.sable.next.test',
    snapshot: () => ({ content: { v: 1, value: local.value } }),
    adopt(content: unknown) {
      const body = content as { v?: number; value?: string } | null;
      if (body?.v !== 1 || typeof body.value !== 'string') return false;
      local.value = body.value;
      return true;
    },
    ...overrides,
  } satisfies SyncedDocument;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearDrafts();
  vi.useRealTimers();
});

describe('AccountSync', () => {
  it('keeps a sent draft cleared after restarting', async () => {
    const roomId = '!room:example.org';
    const document = draftsDocumentFor('');
    const remote = { [document.eventType]: { v: 1, drafts: { [roomId]: { type: 'doc' } } } };
    const { core, commands, announce } = stubCore(remote, {
      canSeal: true,
      states: { [document.eventType]: 'sealed' },
    });
    const sync = new AccountSync();
    const stop = sync.start(core, [document]);
    await vi.runAllTimersAsync();
    expect(readDraft(roomId)?.doc).toEqual({ type: 'doc' });

    clearDraft(roomId);
    sync.push(document);
    announce(document.eventType);
    await vi.advanceTimersByTimeAsync(0);
    sync.push(document);
    await vi.runAllTimersAsync();

    stop();
    clearDrafts();
    const stopRestarted = new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();
    expect(readDraft(roomId)).toBeUndefined();
    stopRestarted();
    expect(commands.setSealedData).toHaveBeenCalledWith({
      event_type: document.eventType,
      content: {
        v: 1,
        drafts: {},
      },
    });
  });

  it('converts v1 account data only when the v2 document is absent', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local, {
      legacy: { eventType: 'old.settings', convert: (content) => content },
    });
    const { core, commands } = stubCore({ 'old.settings': { v: 1, value: 'v1' } });
    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();
    expect(local.value).toBe('v1');
    expect(commands.setData).toHaveBeenCalledWith({
      event_type: document.eventType,
      content: { v: 1, value: 'v1' },
    });
    const current = stubCore({
      'old.settings': { v: 1, value: 'stale' },
      [document.eventType]: { v: 1, value: 'v2' },
    });
    new AccountSync().start(current.core, [document]);
    await vi.runAllTimersAsync();
    expect(local.value).toBe('v2');
    expect(current.commands.data).not.toHaveBeenCalledWith({ event_type: 'old.settings' });
  });
  it('adopts what the account already holds', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local);
    const { core } = stubCore({ [document.eventType]: { v: 1, value: 'remote' } });

    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    expect(local.value).toBe('remote');
  });

  it('seeds the account when the event is unusable', async () => {
    const document = stubDocument({ value: 'local' });
    const { core, commands } = stubCore({ [document.eventType]: { v: 99 } });

    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    expect(commands.setData).toHaveBeenCalledWith({
      event_type: document.eventType,
      content: {
        v: 1,
        value: 'local',
      },
    });
  });

  it('does not upload a payload equal to what it read', async () => {
    const local = { value: 'shared' };
    const document = stubDocument(local);
    const { core, commands } = stubCore({ [document.eventType]: { value: 'shared', v: 1 } });

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();

    sync.push(document);
    await vi.runAllTimersAsync();

    expect(commands.setData).not.toHaveBeenCalled();
  });

  it('does not upload an accepted missing document', async () => {
    const document = stubDocument({ value: '' }, { adopt: (content) => content === null });
    const { core, commands } = stubCore({});

    const stop = new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    expect(commands.setData).not.toHaveBeenCalled();
    stop();
  });

  it('uploads a local change once the debounce elapses', async () => {
    const local = { value: 'shared' };
    const document = stubDocument(local);
    const { core, commands } = stubCore({ [document.eventType]: { v: 1, value: 'shared' } });

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();

    local.value = 'changed';
    sync.push(document);
    expect(commands.setData).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(commands.setData).toHaveBeenCalledWith({
      event_type: document.eventType,
      content: {
        v: 1,
        value: 'changed',
      },
    });
  });

  it('writes nothing before it has been started', async () => {
    const document = stubDocument({ value: 'local' });
    const { commands } = stubCore({ [document.eventType]: { v: 1, value: 'remote' } });

    new AccountSync().push(document);
    await vi.runAllTimersAsync();

    expect(commands.setData).not.toHaveBeenCalled();
  });

  it('re-reads on an account data change from another device', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local);
    const remote: Record<string, unknown> = { [document.eventType]: { v: 1, value: 'first' } };
    const { core, announce } = stubCore(remote);

    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    remote[document.eventType] = { v: 1, value: 'second' };
    announce(document.eventType);
    await vi.runAllTimersAsync();

    expect(local.value).toBe('second');
  });

  it('keeps an edit made after an upload when that upload echoes back', async () => {
    const local = { value: 'shared' };
    const document = stubDocument(local);
    const remote: Record<string, unknown> = { [document.eventType]: { v: 1, value: 'shared' } };
    const { core, announce } = stubCore(remote);

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();

    local.value = 'first';
    sync.push(document);
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote[document.eventType]).toEqual({ v: 1, value: 'first' });

    local.value = 'second';
    sync.push(document);
    announce(document.eventType);
    await vi.advanceTimersByTimeAsync(0);
    expect(local.value).toBe('second');

    await vi.runAllTimersAsync();
    expect(remote[document.eventType]).toEqual({ v: 1, value: 'second' });
  });

  it('merges an edit made on this device with one made on another', async () => {
    type Local = { a: string; b: string };
    const local: Local = { a: 'a0', b: 'b0' };
    const document = {
      eventType: 'moe.sable.next.test',
      snapshot: () => ({ content: { v: 1, ...local } }),
      adopt(content: unknown) {
        const body = content as { v?: number } & Partial<Local>;
        if (body.v !== 1) return false;
        Object.assign(local, { a: body.a, b: body.b });
        return true;
      },
      merge(base: unknown, mine: unknown, theirs: unknown) {
        const [before, ours, remote] = [base, mine, theirs] as Record<string, string>[];
        const take = (key: string) => (ours[key] === before[key] ? remote[key] : ours[key]);
        return { v: 1, a: take('a'), b: take('b') };
      },
    } satisfies SyncedDocument;
    const remote: Record<string, unknown> = { [document.eventType]: { v: 1, a: 'a0', b: 'b0' } };
    const { core, announce } = stubCore(remote);

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();

    local.a = 'a1';
    sync.push(document);
    remote[document.eventType] = { v: 1, a: 'a0', b: 'b1' };
    announce(document.eventType);
    await vi.runAllTimersAsync();

    expect(local).toEqual({ a: 'a1', b: 'b1' });
    expect(remote[document.eventType]).toEqual({ v: 1, a: 'a1', b: 'b1' });
  });

  it('merges an edit made while closed with one made on another device', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    const local = { a: 'a0', b: 'b0' };
    const document = {
      eventType: 'moe.sable.next.test',
      snapshot: () => ({ content: { v: 1, ...local } }),
      adopt(content: unknown) {
        const body = content as { v: number; a: string; b: string };
        Object.assign(local, { a: body.a, b: body.b });
        return true;
      },
      merge(base: unknown, mine: unknown, theirs: unknown) {
        const [before, ours, remote] = [base, mine, theirs] as Record<string, string>[];
        const take = (key: string) => (ours[key] === before[key] ? remote[key] : ours[key]);
        return { v: 1, a: take('a'), b: take('b') };
      },
    } satisfies SyncedDocument;
    const remote: Record<string, unknown> = { [document.eventType]: { v: 1, a: 'a0', b: 'b0' } };
    const { core } = stubCore(remote);

    const first = new AccountSync();
    const stop = first.start(core, [document]);
    await vi.runAllTimersAsync();
    stop();

    local.a = 'a1';
    remote[document.eventType] = { v: 1, a: 'a0', b: 'b1' };
    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    expect(local).toEqual({ a: 'a1', b: 'b1' });
    expect(remote[document.eventType]).toEqual({ v: 1, a: 'a1', b: 'b1' });
  });

  it('leaves a disabled document alone', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local, { enabled: () => false });
    const { core, commands } = stubCore({ [document.eventType]: { v: 1, value: 'remote' } });

    const sync = new AccountSync();
    sync.start(core, [document]);
    sync.push(document);
    await vi.runAllTimersAsync();

    expect(local.value).toBe('local');
    expect(commands.data).not.toHaveBeenCalled();
    expect(commands.setData).not.toHaveBeenCalled();
  });

  it('reports a failed write and retries on the next change', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local);
    const { core, commands } = stubCore({});
    commands.setData.mockRejectedValueOnce(new Error('offline'));

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();
    expect(sync.status).toBe('error');

    local.value = 'again';
    sync.push(document);
    await vi.runAllTimersAsync();

    expect(sync.status).toBe('idle');
    expect(commands.setData).toHaveBeenLastCalledWith({
      event_type: document.eventType,
      content: { v: 1, value: 'again' },
    });
  });

  it('detaches the payload from live state before handing it to the core', async () => {
    const themes = $state([{ id: 'one', css: 'body {}' }]);
    const document = {
      eventType: 'moe.sable.next.test',
      snapshot: () => ({ content: { v: 1, themes } }),
      adopt: () => false,
    } satisfies SyncedDocument;
    const { core, commands } = stubCore({});

    new AccountSync().start(core, [document]);
    await vi.runAllTimersAsync();

    const content = commands.setData.mock.calls[0]?.[0].content;
    themes[0].css = 'body { color: red }';

    expect(content).toEqual({ v: 1, themes: [{ id: 'one', css: 'body {}' }] });
  });

  describe('a sealed document', () => {
    it('is neither adopted nor overwritten while this device lacks the key', async () => {
      const local = { value: 'local' };
      const document = stubDocument(local, { sealed: true });
      const sealing = { canSeal: false, states: { [document.eventType]: 'locked' as SealState } };
      const { core, commands, announce } = stubCore(
        { [document.eventType]: { v: 1, value: 'remote' } },
        sealing
      );
      const sync = new AccountSync();

      sync.start(core, [document]);
      await vi.runAllTimersAsync();
      local.value = 'edited';
      sync.push(document);
      await vi.runAllTimersAsync();

      expect(local.value).toBe('edited');
      expect(commands.setSealedData).not.toHaveBeenCalled();
      expect(commands.sealedData).toHaveBeenCalledTimes(1);

      sealing.canSeal = true;
      sealing.states[document.eventType] = 'sealed';
      announce(ACCOUNT_DATA_KEY_TYPE);
      await vi.runAllTimersAsync();

      expect(local.value).toBe('remote');
      expect(commands.setSealedData).not.toHaveBeenCalled();
    });

    it('reseals a plaintext copy once the key is here, even when nothing changed', async () => {
      const local = { value: 'same' };
      const document = stubDocument(local, { sealed: true });
      const sealing = { canSeal: true, states: {} as Record<string, SealState> };
      const { core, commands } = stubCore(
        { [document.eventType]: { v: 1, value: 'same' } },
        sealing
      );

      new AccountSync().start(core, [document]);
      await vi.runAllTimersAsync();

      expect(commands.setSealedData).toHaveBeenCalledTimes(1);
      expect(sealing.states[document.eventType]).toBe('sealed');
      expect(commands.setData).not.toHaveBeenCalled();
    });

    it('does not reupload its own sealed echo', async () => {
      const local = { value: 'local' };
      const document = stubDocument(local, { sealed: true });
      const sealing = { canSeal: true, states: { [document.eventType]: 'sealed' as SealState } };
      const { core, commands, announce } = stubCore(
        { [document.eventType]: { v: 1, value: 'local' } },
        sealing
      );
      const sync = new AccountSync();

      sync.start(core, [document]);
      await vi.runAllTimersAsync();
      local.value = 'edited';
      sync.push(document);
      await vi.runAllTimersAsync();
      announce(document.eventType);
      await vi.runAllTimersAsync();

      expect(commands.setSealedData).toHaveBeenCalledTimes(1);
      expect(local.value).toBe('edited');
    });
  });
});
