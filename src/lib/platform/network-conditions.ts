import { on } from 'svelte/events';

interface NetworkConnection extends EventTarget {
  type?: string;
  metered?: boolean;
  saveData?: boolean;
}

export interface NetworkConditions {
  available: boolean;
  unmetered: boolean;
}

/** Reports the current conditions at once, then on every change. */
export function watchNetworkConditions(
  report: (conditions: NetworkConditions) => void
): () => void {
  const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
  const changed = (): void => {
    report({
      available: navigator.onLine,
      unmetered:
        connection?.type !== 'cellular' &&
        connection?.metered !== true &&
        connection?.saveData !== true,
    });
  };
  const stops = [
    on(window, 'online', changed),
    on(window, 'offline', changed),
    ...(connection ? [on(connection, 'change', changed)] : []),
  ];
  changed();
  return () => {
    for (const stop of stops) stop();
  };
}
