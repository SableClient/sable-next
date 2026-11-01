import { BaseKeyProvider, isE2EESupported } from 'livekit-client';

import type { CallEncryptionKey } from './call-transport';

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
    super({ ratchetWindowSize: 0, keyringSize: 256, sharedKey: false, failureTolerance: -1 });
  }

  reset(): void {
    this.#generation += 1;
    this.#queue = Promise.resolve();
    this.#update(idleState());
  }

  get state(): KeyProviderState {
    return { ...this.#state };
  }

  override getLatestManuallySetKeyIndex(): number {
    // LiveKit uses this index to restore the publisher key after signaling reconnects.
    return this.#state.keyIndex ?? super.getLatestManuallySetKeyIndex();
  }

  subscribe(listener: (state: KeyProviderState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  setKey(key: CallEncryptionKey, own: boolean): Promise<void> {
    const generation = this.#generation;
    this.#queue = this.#queue.catch(() => undefined).then(() => this.#apply(generation, key, own));
    return this.#queue;
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  waitForOwnKey(identity: string, timeoutMs = 10_000): Promise<void> {
    if (this.#state.ready && this.#state.ownIdentity === identity) return Promise.resolve();
    if (this.#state.lastFailure) return Promise.reject(new Error('own-key-failed'));
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error('own-key-timeout'));
      }, timeoutMs);
      const listener = (state: KeyProviderState): void => {
        const cancelled = generation !== this.#generation;
        if (!cancelled && !state.lastFailure && !(state.ready && state.ownIdentity === identity))
          return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        if (cancelled) reject(new Error('call-cancelled'));
        else if (state.lastFailure) reject(new Error('own-key-failed'));
        else resolve();
      };
      this.#listeners.add(listener);
    });
  }

  async #apply(generation: number, key: CallEncryptionKey, own: boolean): Promise<void> {
    if (generation !== this.#generation) return;

    const subtle = subtleCrypto();
    if (typeof subtle?.importKey !== 'function') {
      if (own) this.#update({ ready: false, lastFailure: 'webcrypto-unavailable' });
      throw new Error('webcrypto-unavailable');
    }

    let material: CryptoKey;
    try {
      material = await subtle.importKey('raw', key.key, 'HKDF', false, ['deriveBits', 'deriveKey']);
    } catch {
      if (generation !== this.#generation) return;
      if (own) this.#update({ ready: false, lastFailure: 'import-failed' });
      throw new Error('import-failed');
    }

    if (generation !== this.#generation) return;

    try {
      this.onSetEncryptionKey(material, key.identity, key.keyIndex);
    } catch {
      if (own) this.#update({ ready: false, lastFailure: 'import-failed' });
      throw new Error('import-failed');
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
      } catch (error) {
        console.warn('[sable call] state listener failed', error);
      }
    }
  }
}
