import { version } from '$app/env';

const VERSION_REPLY_MS = 1_500;
const CHECK_SETTLE_MS = 3_000;

export const webUpdateState = $state<{
  registration: ServiceWorkerRegistration | null;
  worker: ServiceWorker | null;
  generation: number;
}>({ registration: null, worker: null, generation: 0 });

function workerVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise((settle) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      settle(null);
    }, VERSION_REPLY_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      settle(typeof event.data === 'string' ? event.data : null);
    };
    worker.postMessage({ type: 'sable:version' }, [channel.port2]);
  });
}

async function consider(
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker
): Promise<boolean> {
  const reported = await workerVersion(worker);
  if (reported === version) {
    worker.postMessage({ type: 'sable:skip-waiting' });
    webUpdateState.registration = null;
    webUpdateState.worker = null;
    return false;
  }

  if (webUpdateState.worker !== worker) {
    webUpdateState.registration = registration;
    webUpdateState.worker = worker;
    webUpdateState.generation += 1;
  }
  return true;
}

function inspectInstalling(
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker,
  settle: (available: boolean) => void
): void {
  const inspect = (): void => {
    if (worker.state === 'installed') {
      void consider(registration, worker).then(settle);
    }
  };
  worker.addEventListener('statechange', inspect);
  inspect();
}

export async function checkForWebUpdate(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;

  if (registration.waiting) return consider(registration, registration.waiting);

  return new Promise((settle) => {
    let finished = false;
    const finish = (available: boolean): void => {
      if (finished) return;
      finished = true;
      registration.removeEventListener('updatefound', onUpdateFound);
      settle(available);
    };
    const onUpdateFound = (): void => {
      const installing = registration.installing;
      if (!installing) return;
      inspectInstalling(registration, installing, finish);
    };

    registration.addEventListener('updatefound', onUpdateFound, { once: true });
    setTimeout(() => {
      finish(false);
    }, CHECK_SETTLE_MS);
    registration
      .update()
      .then(() => {
        if (registration.waiting) void consider(registration, registration.waiting).then(finish);
      })
      .catch(() => {
        finish(false);
      });
  });
}
