import { runtimeConfig, type SupporterConfig } from '#lib/config/runtime-config.js';
import { communityFeatures } from '#lib/deployment/links.js';

export async function supporterConfig(): Promise<SupporterConfig | null> {
  const config = await runtimeConfig();
  return communityFeatures(config) ? config.supporter : null;
}
