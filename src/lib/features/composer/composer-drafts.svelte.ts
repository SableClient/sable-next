import { fingerprint } from '#lib/settings/fingerprint.js';

import type { ComposerContext } from './composer-context';
import type { StagedFile } from './composer-files';

export interface ComposerDraft {
  doc: unknown;
  staged: StagedFile[];
  nextStagedId: number;
}

const MAX_SYNCED_DRAFTS = 50;
const MAX_OFFERED_PER_ROOM = 8;

const fingerprints = new WeakMap<object, string>();

function docFingerprint(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return fingerprint(doc);
  let cached = fingerprints.get(doc);
  if (cached === undefined) {
    cached = fingerprint(doc);
    fingerprints.set(doc, cached);
  }
  return cached;
}

interface DraftState {
  drafts: Map<string, ComposerDraft>;
  synced: Map<string, string>;
  adopted: Map<string, number>;
  discarded: Map<string, string[]>;
  offered: Map<string, string[]>;
  replies: Map<string, ComposerContext>;
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- changes publish through revision
const accounts = new Map<string, DraftState>();

function stateFor(accountId: string): DraftState {
  let state = accounts.get(accountId);
  if (!state) {
    state = {
      drafts: new Map(),
      synced: new Map(),
      adopted: new Map(),
      discarded: new Map(),
      offered: new Map(),
      replies: new Map(),
    };
    accounts.set(accountId, state);
  }
  return state;
}

const revision = $state({ value: 0 });
const remote = $state({ value: 0 });

export function readDraft(roomId: string, accountId = ''): ComposerDraft | undefined {
  return stateFor(accountId).drafts.get(roomId);
}

export function writeDraft(roomId: string, draft: ComposerDraft, accountId = ''): void {
  const { drafts, discarded } = stateFor(accountId);
  drafts.delete(roomId);
  drafts.set(roomId, draft);
  discarded.delete(roomId);
  revision.value += 1;
}

export function injectDraft(roomId: string, draft: ComposerDraft, accountId = ''): void {
  const { adopted } = stateFor(accountId);
  writeDraft(roomId, draft, accountId);
  adopted.set(roomId, (adopted.get(roomId) ?? 0) + 1);
  remote.value += 1;
}

export function clearDraft(roomId: string, accountId = ''): void {
  const { drafts, discarded, offered, synced } = stateFor(accountId);
  const doc = drafts.get(roomId)?.doc;
  if (!drafts.delete(roomId)) return;
  const stale = [...(offered.get(roomId) ?? []), synced.get(roomId)].filter(
    (value) => value !== undefined
  );
  if (doc !== null && doc !== undefined) stale.push(docFingerprint(doc));
  if (stale.length > 0) discarded.set(roomId, stale);
  revision.value += 1;
}

export function readReply(key: string, accountId = ''): ComposerContext | undefined {
  return stateFor(accountId).replies.get(key);
}

export function writeReply(key: string, reply: ComposerContext | null, accountId = ''): void {
  const { replies } = stateFor(accountId);
  if (reply === null) replies.delete(key);
  else replies.set(key, reply);
}

export function clearDrafts(): void {
  accounts.clear();
  revision.value += 1;
}

export function remoteRevision(roomId: string, accountId = ''): number {
  void remote.value;
  return stateFor(accountId).adopted.get(roomId) ?? 0;
}

export function draftDocuments(accountId = ''): Record<string, unknown> {
  void revision.value;

  const { drafts, offered } = stateFor(accountId);
  const entries = [...drafts.entries()]
    .filter(([, draft]) => draft.doc !== null && draft.doc !== undefined)
    .slice(-MAX_SYNCED_DRAFTS);
  for (const [roomId, draft] of entries) {
    const current = docFingerprint(draft.doc);
    const seen = (offered.get(roomId) ?? []).filter((value) => value !== current);
    offered.set(roomId, [...seen, current].slice(-MAX_OFFERED_PER_ROOM));
  }
  return Object.fromEntries(entries.map(([roomId, draft]) => [roomId, draft.doc]));
}

export function adoptDraftDocuments(documents: Record<string, unknown>, accountId = ''): void {
  const { drafts, synced, adopted, discarded } = stateFor(accountId);
  let changed = false;
  const dropped = [...synced.keys()].filter((roomId) => !(roomId in documents));
  for (const roomId of [...Object.keys(documents), ...dropped]) {
    const existing = drafts.get(roomId);
    const held = existing?.doc ?? null;
    const local = held === null ? null : docFingerprint(held);
    const doc = documents[roomId] ?? null;
    const next = doc === null ? null : docFingerprint(doc);
    const untouched = local === null || local === synced.get(roomId);

    if (next === null) synced.delete(roomId);
    else synced.set(roomId, next);
    if (next === null || !discarded.get(roomId)?.includes(next)) discarded.delete(roomId);
    if (!untouched || local === next || discarded.has(roomId)) continue;

    if (doc === null && (existing?.staged.length ?? 0) === 0) drafts.delete(roomId);
    else
      drafts.set(roomId, {
        doc,
        staged: existing?.staged ?? [],
        nextStagedId: existing?.nextStagedId ?? 0,
      });
    adopted.set(roomId, (adopted.get(roomId) ?? 0) + 1);
    changed = true;
  }
  revision.value += 1;
  if (changed) remote.value += 1;
}
