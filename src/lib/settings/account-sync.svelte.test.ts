import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/CoreEvent';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { AccountSync, type SyncedDocument } from './account-sync.svelte';

function stubCore(remote: Record<string, unknown>) {
  const listeners: ((event: CoreEvent) => void)[] = [];
  const core = {
    commands: {
      accountData: vi.fn((eventType: string) => Promise.resolve(remote[eventType] ?? null)),
      setAccountData: vi.fn((eventType: string, content: unknown) => {
        remote[eventType] = content;
        return Promise.resolve();
      }),
    },
    subscribeEvents: vi.fn((listener: (event: CoreEvent) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
  };

  return {
    core: core as unknown as CoreClient,
    commands: core.commands,
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
  vi.useRealTimers();
});

describe('AccountSync', () => {
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

    expect(commands.setAccountData).toHaveBeenCalledWith(document.eventType, {
      v: 1,
      value: 'local',
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

    expect(commands.setAccountData).not.toHaveBeenCalled();
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
    expect(commands.setAccountData).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(commands.setAccountData).toHaveBeenCalledWith(document.eventType, {
      v: 1,
      value: 'changed',
    });
  });

  it('writes nothing before it has been started', async () => {
    const document = stubDocument({ value: 'local' });
    const { commands } = stubCore({ [document.eventType]: { v: 1, value: 'remote' } });

    new AccountSync().push(document);
    await vi.runAllTimersAsync();

    expect(commands.setAccountData).not.toHaveBeenCalled();
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

  it('leaves a disabled document alone', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local, { enabled: () => false });
    const { core, commands } = stubCore({ [document.eventType]: { v: 1, value: 'remote' } });

    const sync = new AccountSync();
    sync.start(core, [document]);
    sync.push(document);
    await vi.runAllTimersAsync();

    expect(local.value).toBe('local');
    expect(commands.accountData).not.toHaveBeenCalled();
    expect(commands.setAccountData).not.toHaveBeenCalled();
  });

  it('reports a failed write and retries on the next change', async () => {
    const local = { value: 'local' };
    const document = stubDocument(local);
    const { core, commands } = stubCore({});
    commands.setAccountData.mockRejectedValueOnce(new Error('offline'));

    const sync = new AccountSync();
    sync.start(core, [document]);
    await vi.runAllTimersAsync();
    expect(sync.status).toBe('error');

    local.value = 'again';
    sync.push(document);
    await vi.runAllTimersAsync();

    expect(sync.status).toBe('idle');
    expect(commands.setAccountData).toHaveBeenLastCalledWith(document.eventType, {
      v: 1,
      value: 'again',
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

    const content = commands.setAccountData.mock.calls[0]?.[1];
    themes[0].css = 'body { color: red }';

    expect(content).toEqual({ v: 1, themes: [{ id: 'one', css: 'body {}' }] });
  });
});
