import * as Sentry from '@sentry/sveltekit';
import { getLogger, LoggerNames } from 'livekit-client';

import { recordDebugLog, type DebugLogLevel } from '#lib/observability/debug-log.svelte.js';

type Method = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const debugLevel = (method: Method): DebugLogLevel => (method === 'trace' ? 'debug' : method);

let routed = false;

// setLogExtension still prints to the console, which Sentry captures as one issue per
// transient network fault, so the loglevel method factory is replaced instead.
export function routeLivekitLogs(): void {
  if (routed) return;
  routed = true;
  for (const name of Object.values(LoggerNames)) {
    const logger = getLogger(name);
    logger.methodFactory = (method) => (message: string, context?: object) => {
      recordDebugLog(debugLevel(method), 'call', name, message, context);
      if (method === 'warn' || method === 'error') {
        Sentry.addBreadcrumb({
          category: 'livekit',
          level: method === 'error' ? 'error' : 'warning',
          message,
          data: { logger: name, ...context },
        });
      }
    };
    logger.setLevel(logger.getLevel());
  }
}
