import { loadHomeservers } from '#lib/features/auth/shared/homeservers.svelte.js';

export const prerender = true;
export const ssr = false;

export async function load(): Promise<void> {
  await loadHomeservers();
}
