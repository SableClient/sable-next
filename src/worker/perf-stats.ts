type CallTiming = { count: number; totalMs: number; maxMs: number };

export type PerfSnapshot = {
  idb: { transactions: number; requests: number; aborts: number; stores: Record<string, number> };
  calls: Record<string, CallTiming>;
  memory: { wasmBytes: number };
};

type IdbScope = {
  IDBDatabase?: typeof IDBDatabase;
  IDBObjectStore?: typeof IDBObjectStore;
  IDBIndex?: typeof IDBIndex;
};

const REQUEST_METHODS = [
  'get',
  'getAll',
  'getAllKeys',
  'getKey',
  'count',
  'openCursor',
  'openKeyCursor',
  'put',
  'add',
  'delete',
  'clear',
] as const;

export class PerfStats {
  private transactions = 0;
  private requests = 0;
  private aborts = 0;
  private readonly stores = new Map<string, number>();
  private readonly calls = new Map<string, CallTiming>();

  /** Wraps the prototypes rather than the SDK, so reads from every layer are counted. */
  instrument({ IDBDatabase, IDBObjectStore, IDBIndex }: IdbScope): void {
    if (!IDBDatabase || !IDBObjectStore || !IDBIndex) return;
    const countTransaction = (created: IDBTransaction): void => {
      this.transactions += 1;
      created.addEventListener('abort', () => {
        this.aborts += 1;
      });
    };
    const countRequest = (key: string): void => {
      this.requests += 1;
      this.stores.set(key, (this.stores.get(key) ?? 0) + 1);
    };

    const transaction: unknown = Reflect.get(IDBDatabase.prototype, 'transaction');
    if (typeof transaction !== 'function') return;
    Reflect.set(
      IDBDatabase.prototype,
      'transaction',
      function (this: IDBDatabase, ...args: unknown[]): IDBTransaction {
        const created = Reflect.apply(transaction, this, args) as IDBTransaction;
        countTransaction(created);
        return created;
      }
    );

    for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
      for (const method of REQUEST_METHODS) {
        const original: unknown = Reflect.get(prototype, method);
        if (typeof original !== 'function') continue;
        Reflect.set(
          prototype,
          method,
          function (this: IDBObjectStore | IDBIndex, ...args: unknown[]): IDBRequest {
            const store = this instanceof IDBIndex ? this.objectStore.name : this.name;
            countRequest(`${store}.${method}`);
            return Reflect.apply(original, this, args) as IDBRequest;
          }
        );
      }
    }
  }

  recordCall(method: string, elapsedMs: number): void {
    const timing = this.calls.get(method) ?? { count: 0, totalMs: 0, maxMs: 0 };
    timing.count += 1;
    timing.totalMs += elapsedMs;
    timing.maxMs = Math.max(timing.maxMs, elapsedMs);
    this.calls.set(method, timing);
  }

  snapshot(wasmMemory?: WebAssembly.Memory): PerfSnapshot {
    return {
      memory: { wasmBytes: wasmMemory?.buffer.byteLength ?? 0 },
      idb: {
        transactions: this.transactions,
        requests: this.requests,
        aborts: this.aborts,
        stores: Object.fromEntries(this.stores),
      },
      calls: Object.fromEntries(this.calls),
    };
  }
}
