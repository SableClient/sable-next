import type { CoreClient } from '#lib/core/client.svelte.js';

import { fingerprint } from './fingerprint.js';

export const ACCOUNT_DATA_KEY_TYPE = 'dev.zirco.msc4483.account_data.key';

export type AccountSyncStatus = 'idle' | 'syncing' | 'partial' | 'error';

export interface SyncedSnapshot {
  content: unknown;
  partial?: boolean;
}

export interface SyncedDocument {
  eventType: string;
  sealed?: boolean;
  debounceMs?: number;
  enabled?: () => boolean;
  snapshot: () => SyncedSnapshot;
  adopt: (content: unknown) => boolean;
}

interface DocumentState {
  pending: SyncedSnapshot | null;
  remote: string | null;
  pulled: boolean;
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  status: AccountSyncStatus;
}

const DEFAULT_DEBOUNCE_MS = 2000;

function detach(snapshot: SyncedSnapshot): SyncedSnapshot {
  return { ...snapshot, content: $state.snapshot(snapshot.content) };
}

export class AccountSync {
  status = $state<AccountSyncStatus>('idle');
  lastSyncedAt = $state<number | null>(null);

  #core: CoreClient | null = null;
  #generation = 0;
  #accountId: string | undefined;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- not a render source
  readonly #states = new Map<string, DocumentState>();

  start(core: CoreClient, documents: readonly SyncedDocument[]): () => void {
    const generation = ++this.#generation;
    const accountId = core.session?.account_id;
    if (accountId !== this.#accountId) {
      for (const state of this.#states.values()) clearTimeout(state.timer);
      this.#states.clear();
      this.#accountId = accountId;
    }
    this.#core = core;

    for (const document of documents) {
      const state = this.#stateFor(document.eventType);
      clearTimeout(state.timer);
      state.remote = null;
      state.pulled = false;
      state.locked = false;
      state.status = 'idle';
    }
    this.#refresh();

    const stopEvents = core.subscribeEvents((event) => {
      if (event.type !== 'account_data_changed') return;

      if (event.event_type === ACCOUNT_DATA_KEY_TYPE) {
        for (const sealed of documents) if (sealed.sealed) void this.#pull(sealed, generation);
        return;
      }
      const document = documents.find((entry) => entry.eventType === event.event_type);
      if (document) void this.#pull(document, generation);
    });
    for (const document of documents) void this.#pull(document, generation);

    return () => {
      stopEvents();
      if (generation !== this.#generation) return;

      this.#generation += 1;
      this.#core = null;
      for (const state of this.#states.values()) clearTimeout(state.timer);
      this.status = 'idle';
      this.lastSyncedAt = null;
    };
  }

  push(document: SyncedDocument): void {
    const state = this.#stateFor(document.eventType);
    state.pending = detach(document.snapshot());
    this.#schedule(document, state);
  }

  #stateFor(eventType: string): DocumentState {
    const existing = this.#states.get(eventType);
    if (existing) return existing;

    const state: DocumentState = {
      pending: null,
      remote: null,
      pulled: false,
      locked: false,
      timer: undefined,
      status: 'idle',
    };
    this.#states.set(eventType, state);
    return state;
  }

  #schedule(document: SyncedDocument, state: DocumentState): void {
    clearTimeout(state.timer);
    if (this.#core === null || document.enabled?.() === false || state.locked) return;
    if (!state.pulled) {
      void this.#pull(document, this.#generation);
      return;
    }
    if (state.pending === null || fingerprint(state.pending.content) === state.remote) return;

    const generation = this.#generation;
    state.timer = setTimeout(
      () => void this.#upload(document, generation),
      document.debounceMs ?? DEFAULT_DEBOUNCE_MS
    );
  }

  async #pull(document: SyncedDocument, generation: number): Promise<void> {
    const core = this.#core;
    if (core === null || generation !== this.#generation || document.enabled?.() === false) return;

    const state = this.#stateFor(document.eventType);
    let content: unknown;
    let unsealed = false;
    try {
      if (document.sealed) {
        const sealed = await core.commands.sealedAccountData(document.eventType);
        if (generation !== this.#generation) return;
        state.locked = sealed.state === 'locked';
        if (state.locked) {
          state.pulled = false;
          state.status = 'idle';
          this.#refresh();
          return;
        }
        content = sealed.content;
        unsealed = sealed.state === 'plain' && sealed.can_seal && sealed.content !== null;
      } else {
        content = await core.commands.accountData(document.eventType);
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      state.status = 'error';
      this.#refresh();
      console.debug('[sable settings]', document.eventType, 'could not be read', error);
      return;
    }
    if (generation !== this.#generation) return;

    state.pulled = true;
    if (!document.adopt(content)) {
      state.pending ??= detach(document.snapshot());
      this.#schedule(document, state);
      return;
    }

    const next = detach(document.snapshot());
    state.pending = next;
    state.remote = unsealed ? null : fingerprint(next.content);
    state.status = next.partial === true ? 'partial' : 'idle';
    this.lastSyncedAt = Date.now();
    this.#refresh();
    if (unsealed) this.#schedule(document, state);
  }

  async #upload(document: SyncedDocument, generation: number): Promise<void> {
    const core = this.#core;
    const state = this.#stateFor(document.eventType);
    if (core === null || state.pending === null || generation !== this.#generation) return;

    const sent = state.pending;
    state.status = 'syncing';
    this.#refresh();
    try {
      await (document.sealed
        ? core.commands.setSealedAccountData(document.eventType, sent.content)
        : core.commands.setAccountData(document.eventType, sent.content));
    } catch (error) {
      if (generation !== this.#generation) return;
      state.status = 'error';
      this.#refresh();
      console.debug('[sable settings]', document.eventType, 'could not be written', error);
      return;
    }
    if (generation !== this.#generation) return;

    state.remote = fingerprint(sent.content);
    state.status = sent.partial === true ? 'partial' : 'idle';
    this.lastSyncedAt = Date.now();
    this.#refresh();
  }

  #refresh(): void {
    const statuses = [...this.#states.values()].map((state) => state.status);
    this.status =
      statuses.find((status) => status === 'error') ??
      statuses.find((status) => status === 'syncing') ??
      statuses.find((status) => status === 'partial') ??
      'idle';
  }
}

export const accountSync = new AccountSync();
