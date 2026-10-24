import type { Client } from './client';

/** Slices the UI reads; a runtime built without one does not match this build. */
export const NEEDED_SLICES = ['rooms', 'sidebar', 'timeline'];

let current: Promise<Client> | undefined;

export function provideRuntime(client: Promise<Client>): void {
  client.catch(() => undefined);
  current = client;
}

export function runtime(): Promise<Client> {
  return current ?? Promise.reject(new Error('the runtime has not started'));
}
