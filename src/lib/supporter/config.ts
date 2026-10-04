import { runtimeConfig, type SupporterConfig } from '#lib/config/runtime-config.js';

export async function supporterConfig(): Promise<SupporterConfig | null> {
  return (await runtimeConfig()).supporter;
}
