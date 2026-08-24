import { BaseKeyProvider, isE2EESupported } from 'livekit-client';

import { ignoreError, type CallEncryptionKey } from './call-transport';

export type KeyImportFailure = 'webcrypto-unavailable' | 'import-failed';

export type KeyProviderState = {
  ready: boolean;
  ownIdentity: string | null;
  keyIndex: number | null;
  lastFailure: KeyImportFailure | null;
};

const subtleCrypto = (): SubtleCrypto | undefined =>
  (globalThis.crypto as Crypto | undefined)?.subtle;

export const isCallE2eeSupported = (): boolean =>
  typeof subtleCrypto()?.importKey === 'function' && isE2EESupported();

const idleState = (): KeyProviderState => ({
  ready: false,
  ownIdentity: null,
  keyIndex: null,
  lastFailure: null,
});

export class MatrixKeyProvider extends BaseKeyProvider {
  #generation = 0;
  #queue: Promise<void> = Promise.resolve();
  #state: KeyProviderState = idleState();
  readonly #listeners = new Set<(state: KeyProviderState) => void>();

  constructor() {
    super({ ratchetWindowSize: 10, keyringSize: 256, sharedKey: false });
  }

  reset(): void {
    this.#generation += 1;
    this.#queue = Promise.resolve();
    this.#update(idleState());
  }

  get state(): KeyProviderState {
    return { ...this.#state };
  }

  subscribe(listener: (state: KeyProviderState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  setKey(key: CallEncryptionKey, own: boolean): void {
    const generation = this.#generation;
    this.#queue = this.#queue.then(() => this.#apply(generation, key, own));
  }

  async #apply(generation: number, key: CallEncryptionKey, own: boolean): Promise<void> {
    if (generation !== this.#generation) return;

    const subtle = subtleCrypto();
    if (typeof subtle?.importKey !== 'function') {
      this.#update({ lastFailure: 'webcrypto-unavailable' });
      return;
    }

    let material: CryptoKey;
    try {
      material = await subtle.importKey('raw', key.key, 'HKDF', false, ['deriveBits', 'deriveKey']);
    } catch {
      this.#update({ lastFailure: 'import-failed' });
      return;
    }

    if (generation !== this.#generation) return;

    try {
      this.onSetEncryptionKey(material, key.identity, key.keyIndex);
    } catch {
      this.#update({ lastFailure: 'import-failed' });
      return;
    }

    if (own) {
      this.#update({
        ready: true,
        ownIdentity: key.identity,
        keyIndex: key.keyIndex,
        lastFailure: null,
      });
    }
  }

  #update(changes: Partial<KeyProviderState>): void {
    this.#state = { ...this.#state, ...changes };
    const snapshot = this.state;
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        ignoreError();
      }
    }
  }
}
