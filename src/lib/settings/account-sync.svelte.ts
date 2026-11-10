import { on } from 'svelte/events';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

import { readJson, removeLocalValue, writeJson } from '#lib/platform/local-json.js';

import { fingerprint } from './fingerprint.js';
import { setAccountData, setSealedAccountData } from '#lib/core/api/account.svelte.js';

export const ACCOUNT_DATA_KEY_TYPE = 'dev.zirco.msc4483.account_data.key';

export type AccountSyncStatus = 'idle' | 'syncing' | 'partial' | 'error';

export interface SyncedSnapshot {
  content: unknown;
  partial?: boolean;
  skipped?: string[];
}

export interface SyncedDocument {
  eventType: string;
  sealed?: boolean;
  debounceMs?: number;
  enabled?: () => boolean;
  snapshot: () => SyncedSnapshot;
  /** `firstSync` is true while no merge base exists yet, so local-only entries should survive the pull. */
  adopt: (content: unknown, firstSync?: boolean) => boolean;
  merge?: (base: unknown, local: unknown, remote: unknown) => unknown;
}

interface DocumentState {
  pending: SyncedSnapshot | null;
  base: unknown;
  remote: string | null;
  /** Fields of the account's copy this build does not write, kept in every upload. */
  carried: Record<string, unknown> | null;
  sent: string | null;
  sending: string | null;
  pulling: boolean;
  queued: { document: SyncedDocument; generation: number } | null;
  pulled: boolean;
  locked: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  status: AccountSyncStatus;
}

const DEFAULT_DEBOUNCE_MS = 2000;
const BASE_KEY_PREFIX = 'sable-sync-base';

function pageHidden(): boolean {
  return globalThis.document.visibilityState === 'hidden';
}

function detach(snapshot: SyncedSnapshot): SyncedSnapshot {
  return { ...snapshot, content: $state.snapshot(snapshot.content) };
}

function unknownFields(remote: unknown, local: unknown): Record<string, unknown> | null {
  if (!isRecord(remote) || !isRecord(local)) return null;

  const kept = Object.entries(remote).filter(([key]) => !(key in local));
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

function withCarried(
  snapshot: SyncedSnapshot,
  carried: Record<string, unknown> | null
): SyncedSnapshot {
  if (carried === null || !isRecord(snapshot.content)) return snapshot;

  return { ...snapshot, content: { ...carried, ...snapshot.content } };
}

export class AccountSync {
  status = $state<AccountSyncStatus>('idle');
  lastSyncedAt = $state<number | null>(null);
  skipped = $state.raw<string[]>([]);

  #core: CoreClient | null = null;
  #generation = 0;
  #accountId: string | undefined;
  #documents: readonly SyncedDocument[] = [];
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
    this.#documents = documents;

    for (const document of documents) {
      const state = this.#stateFor(document.eventType);
      clearTimeout(state.timer);
      state.remote = null;
      state.pulled = false;
      state.locked = false;
      state.status = 'idle';
      if (document.merge && state.base === null) {
        state.base = readJson(this.#baseKey(document), (value) => value, null);
      }
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
    const stopHidden = on(globalThis.document, 'visibilitychange', () => {
      if (pageHidden()) this.#flush();
    });

    return () => {
      stopEvents();
      stopHidden();
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
    state.pending = this.#snapshot(document, state);
    this.#schedule(document, state);
  }

  #stateFor(eventType: string): DocumentState {
    const existing = this.#states.get(eventType);
    if (existing) return existing;

    const state: DocumentState = {
      pending: null,
      base: null,
      remote: null,
      carried: null,
      sent: null,
      sending: null,
      pulling: false,
      queued: null,
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
      if (!state.pulling) void this.#pull(document, this.#generation);
      return;
    }
    if (state.pending === null) return;

    const local = fingerprint(state.pending.content);
    if (local === state.remote || local === state.sending) return;

    const generation = this.#generation;
    if (pageHidden()) {
      void this.#upload(document, generation);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.#upload(document, generation);
    }, document.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  #flush(): void {
    for (const document of this.#documents) {
      const state = this.#states.get(document.eventType);
      if (state?.timer !== undefined) this.#schedule(document, state);
    }
  }

  #snapshot(document: SyncedDocument, state: DocumentState): SyncedSnapshot {
    return withCarried(detach(document.snapshot()), state.carried);
  }

  #adopted(document: SyncedDocument, state: DocumentState, remote: unknown): SyncedSnapshot {
    const snapshot = detach(document.snapshot());
    state.carried = unknownFields(remote, snapshot.content);
    return withCarried(snapshot, state.carried);
  }

  /** Content already uploaded is not sent again over another writer's version of it. */
  #settle(state: DocumentState): boolean {
    if (state.pending === null || fingerprint(state.pending.content) !== state.sent) return false;

    state.remote = state.sent;
    return true;
  }

  /** One read at a time per document, so a burst of changes ends in a single re-read. */
  async #pull(document: SyncedDocument, generation: number): Promise<void> {
    if (this.#core === null || generation !== this.#generation) return;
    if (document.enabled?.() === false) return;

    const state = this.#stateFor(document.eventType);
    if (state.pulling) {
      state.queued = { document, generation };
      return;
    }

    state.pulling = true;
    try {
      await this.#read(document, generation, state);
    } finally {
      state.pulling = false;
      const queued = state.queued;
      state.queued = null;
      if (queued) void this.#pull(queued.document, queued.generation);
    }
  }

  async #read(document: SyncedDocument, generation: number, state: DocumentState): Promise<void> {
    const core = this.#core;
    if (core === null) return;

    let content: unknown;
    let unsealed = false;
    try {
      if (document.sealed) {
        const sealed = await core.rpc.account.sealedData({ event_type: document.eventType });
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
        content = await core.rpc.account.data({ event_type: document.eventType });
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      state.status = 'error';
      this.#refresh();
      console.debug('[sable settings]', document.eventType, 'could not be read', error);
      return;
    }
    if (generation !== this.#generation) return;

    if (state.base !== null) state.pending ??= this.#snapshot(document, state);
    if (this.#ahead(state)) {
      state.pulled = true;
      const merged =
        content === null ? null : document.merge?.(state.base, state.pending?.content, content);
      if (merged !== null && merged !== undefined && document.adopt(merged)) {
        state.pending = this.#adopted(document, state, content);
        this.#rebase(document, state, content);
        state.remote = fingerprint(content);
      }
      this.#schedule(document, state);
      return;
    }

    state.pulled = true;
    if (!document.adopt(content, state.base === null)) {
      state.pending ??= this.#snapshot(document, state);
      this.#settle(state);
      this.#schedule(document, state);
      return;
    }

    const next = this.#adopted(document, state, content);
    state.pending = next;
    this.#rebase(document, state, next.content);
    if (unsealed) state.remote = null;
    else if (!this.#settle(state)) state.remote = fingerprint(content ?? next.content);
    state.status = next.partial === true ? 'partial' : 'idle';
    this.lastSyncedAt = Date.now();
    this.#refresh();
    this.#schedule(document, state);
  }

  #baseKey(document: SyncedDocument): string {
    return `${BASE_KEY_PREFIX}:${this.#accountId ?? ''}:${document.eventType}`;
  }

  #rebase(document: SyncedDocument, state: DocumentState, base: unknown): void {
    state.base = base;
    if (!document.merge) return;

    const key = this.#baseKey(document);
    removeLocalValue(key);
    writeJson(key, base, '[sable settings] sync base not persisted');
  }

  #ahead(state: DocumentState): boolean {
    return (
      state.base !== null &&
      state.pending !== null &&
      fingerprint(state.pending.content) !== fingerprint(state.base)
    );
  }

  async #upload(document: SyncedDocument, generation: number): Promise<void> {
    const core = this.#core;
    const state = this.#stateFor(document.eventType);
    if (core === null || state.pending === null || generation !== this.#generation) return;

    const sent = state.pending;
    const sending = fingerprint(sent.content);
    state.sending = sending;
    state.status = 'syncing';
    this.#refresh();
    try {
      await (document.sealed
        ? setSealedAccountData(core.rpc, document.eventType, sent.content)
        : setAccountData(core.rpc, document.eventType, sent.content));
    } catch (error) {
      if (generation !== this.#generation) return;
      state.status = 'error';
      this.#refresh();
      console.debug('[sable settings]', document.eventType, 'could not be written', error);
      return;
    } finally {
      if (state.sending === sending) state.sending = null;
    }
    if (generation !== this.#generation) return;

    this.#rebase(document, state, sent.content);
    state.remote = sending;
    state.sent = sending;
    state.status = sent.partial === true ? 'partial' : 'idle';
    this.lastSyncedAt = Date.now();
    this.#refresh();
  }

  #refresh(): void {
    const states = [...this.#states.values()];
    this.skipped = states.flatMap((state) =>
      state.status === 'partial' ? (state.pending?.skipped ?? []) : []
    );
    const statuses = states.map((state) => state.status);
    this.status =
      statuses.find((status) => status === 'error') ??
      statuses.find((status) => status === 'syncing') ??
      statuses.find((status) => status === 'partial') ??
      'idle';
  }
}

export const accountSync = new AccountSync();
