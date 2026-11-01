import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { untrack } from 'svelte';

import {
  clearDraft,
  readDraft,
  remoteRevision,
  writeDraft,
  type ComposerDraft,
} from '#lib/composer/composer-drafts.svelte.js';

import type { ComposerEditor } from './editor/composer-editor';
import { composerSchema } from './editor/schema';

const DRAFT_PERSIST_MS = 500;

type DraftFiles = Pick<ComposerDraft, 'staged' | 'nextStagedId'>;

interface DraftOptions {
  editor: ComposerEditor;
  files: () => DraftFiles;
  setFiles: (files: DraftFiles) => void;
  onLeave: (roomId: string) => void;
}

export class DraftSync {
  preEdit: ProseMirrorNode | undefined;

  #activeKey = $state<string | null>(null);
  #account = '';
  #roomId = '';
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #seenRemote = 0;

  constructor(private readonly options: DraftOptions) {}

  persist(key: string): void {
    const { editor, files } = this.options;
    const doc = this.preEdit ?? (editor.isEmpty() ? undefined : editor.doc());
    const { staged, nextStagedId } = files();
    if (!doc && staged.length === 0) clearDraft(key, this.#account);
    else writeDraft(key, { doc: doc?.toJSON() ?? null, staged, nextStagedId }, this.#account);
  }

  schedulePersist(): void {
    clearTimeout(this.#timeout);
    this.#timeout = setTimeout(() => {
      this.#timeout = undefined;
      if (this.#activeKey !== null) this.persist(this.#activeKey);
    }, DRAFT_PERSIST_MS);
  }

  flush(): void {
    if (this.#timeout === undefined) return;
    clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (this.#activeKey !== null) this.persist(this.#activeKey);
  }

  open(key: string, accountId: string, roomId: string): void {
    if (this.#activeKey === key && this.#account === accountId) return;
    const { editor, setFiles, onLeave } = this.options;
    const previous = this.#activeKey;
    clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (previous !== null) {
      untrack(() => {
        this.persist(previous);
      });
    }
    if (this.#account !== accountId) this.preEdit = undefined;
    if (previous !== null) {
      this.preEdit = undefined;
      onLeave(this.#roomId);
    }
    this.#activeKey = key;
    this.#account = accountId;
    this.#roomId = roomId;

    untrack(() => {
      this.#seenRemote = remoteRevision(key, accountId);
      const draft = readDraft(key, this.#account);
      if (draft) {
        setFiles(draft);
        editor.clear();
        if (draft.doc) editor.setDoc(composerSchema.nodeFromJSON(draft.doc));
      } else if (previous !== null) {
        setFiles({ staged: [], nextStagedId: 0 });
        editor.clear();
      }
      if (previous !== null) editor.clearHistory();
    });
  }

  syncRemote(key: string, accountId: string): void {
    const revision = remoteRevision(key, accountId);
    untrack(() => {
      if (this.#activeKey !== key || revision === this.#seenRemote) return;
      this.#seenRemote = revision;
      if (this.#timeout !== undefined || this.preEdit !== undefined) return;

      const { editor, setFiles } = this.options;
      const draft = readDraft(key, this.#account);
      if (draft) setFiles(draft);
      editor.clear();
      if (draft?.doc) editor.setDoc(composerSchema.nodeFromJSON(draft.doc));
    });
  }

  dispose(): void {
    clearTimeout(this.#timeout);
    if (this.#activeKey !== null) this.persist(this.#activeKey);
  }
}
