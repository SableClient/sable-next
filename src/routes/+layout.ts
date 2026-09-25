import { loadHomeservers } from '#lib/features/auth/shared/homeservers.svelte.js';
import { loadPasswordFields } from '#lib/features/auth/shared/password-fields.svelte.js';

export const prerender = true;
export const ssr = false;

export async function load(): Promise<void> {
  await Promise.all([loadHomeservers(), loadPasswordFields()]);
}
