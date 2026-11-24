/**
 * The search database lives in a dedicated worker, which only a tab can start.
 * One tab at a time holds a lock for that, and hands the core one end of a
 * channel to the worker. When the tab goes away the lock passes to the next
 * tab, which starts a worker of its own and hands the core a new channel.
 */

export const SEARCH_DATABASE_LOCK = 'sable-search-db';

export interface SearchWorker {
  postMessage(message: { port: MessagePort }, transfer: Transferable[]): void;
  terminate(): void;
}

export interface CoreEndpoint {
  postMessage(message: { searchPort: MessagePort }, transfer: Transferable[]): void;
}

export interface SearchDatabaseHostDeps {
  locks: Pick<LockManager, 'request'> | undefined;
  spawn: () => SearchWorker;
  channel: () => MessageChannel;
}

export interface SearchDatabaseHost {
  /** Gives the core a channel as soon as this tab owns the database, and again after the core is replaced. */
  attach(core: CoreEndpoint): void;
}

export function createSearchDatabaseHost(deps: SearchDatabaseHostDeps): SearchDatabaseHost {
  let worker: SearchWorker | null = null;
  let core: CoreEndpoint | null = null;
  let started = false;

  function handOver(): void {
    if (!worker || !core) return;
    const { port1, port2 } = deps.channel();
    worker.postMessage({ port: port1 }, [port1]);
    core.postMessage({ searchPort: port2 }, [port2]);
  }

  function own(): Promise<never> {
    // Without the worker the core has no local index and searches the server instead.
    try {
      worker = deps.spawn();
      handOver();
    } catch (error) {
      console.error('[sable search] the search database worker could not start', error);
    }
    // Held until the tab ends, which is what hands the lock on.
    return new Promise<never>(() => {});
  }

  function start(): void {
    if (started) return;
    started = true;
    if (!deps.locks) {
      void own();
      return;
    }
    void deps.locks.request(SEARCH_DATABASE_LOCK, own);
  }

  return {
    attach(endpoint) {
      const first = !started;
      core = endpoint;
      start();
      if (!first) handOver();
    },
  };
}
