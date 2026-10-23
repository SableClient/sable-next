import * as Sentry from '@sentry/sveltekit';
import { on } from 'svelte/events';

import type { Transport } from './index';
import { createWebTransport, type CoreConnection } from './web';
import { createWebLink } from './web-runtime';
import { resetWebStorage } from '#lib/platform/session-storage.js';

function openNativeCore(): CoreConnection {
  const { port1, port2 } = new MessageChannel();
  window.postMessage('sable-core-connect', window.location.origin, [port2]);

  return {
    port: port1,
    onFailure(handler) {
      const release = on(window, 'message', (event) => {
        if (event.source !== window) return;
        const exit = (event.data as { sableCoreExit?: unknown } | null)?.sableCoreExit;
        if (typeof exit !== 'string') return;
        release();
        handler(exit);
      });
    },
    retire() {},
    copiesBuffers: true,
  };
}

export function createNativeLink() {
  return createWebLink(() => ({
    handOver: (port) => {
      window.postMessage('sable-runtime-connect', window.location.origin, [port]);
    },
    onFailure: (handler) => {
      const release = on(window, 'message', (event) => {
        if (event.source !== window) return;
        const exit = (event.data as { sableCoreExit?: unknown } | null)?.sableCoreExit;
        if (typeof exit !== 'string') return;
        release();
        handler(exit);
      });
    },
    retire() {},
  }));
}

export function createElectronTransport(): Transport {
  const transport = createWebTransport(openNativeCore);

  return {
    ...transport,

    async resetCaches(accountIds) {
      try {
        await transport.call('session.reset_local_cache', {});
        await resetWebStorage(accountIds);
      } catch (error) {
        Sentry.captureException(error, { tags: { source: 'cache-reset' } });
        console.error('[sable transport] the local caches were not fully cleared', error);
      }
    },

    deleteAccountStore() {
      return Promise.resolve();
    },
  };
}
