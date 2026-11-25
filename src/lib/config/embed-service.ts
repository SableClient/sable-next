import { runtimeConfig } from './runtime-config.js';

let warnedMissing = false;

export async function embedService(): Promise<string | null> {
  const service = (await runtimeConfig()).embeds.serviceUrl;
  if (service === null && !warnedMissing) {
    warnedMissing = true;
    console.warn('[sable embeds] embeds.serviceUrl is not set');
  }
  return service;
}

export function embedServiceUrl(
  service: string,
  path: string,
  params: Record<string, string>
): string {
  const url = new URL(`${service}/_soliditas/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}
