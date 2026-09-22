import type { Component } from 'svelte';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { BooleanPreference } from '#lib/settings/registry.js';

import { parseYoutubeLink } from './youtube';
import YoutubeEmbed from './YoutubeEmbed.svelte';

export type EmbedComponent = Component<{ url: string }>;

interface EmbedProvider {
  preference: BooleanPreference;
  matches: (url: string) => boolean;
  component: EmbedComponent;
}

const PROVIDERS: EmbedProvider[] = [
  {
    preference: 'youtubeEmbeds',
    matches: (url) => parseYoutubeLink(url) !== null,
    component: YoutubeEmbed,
  },
];

export function findEmbed(url: string, encrypted: boolean | null): EmbedComponent | null {
  if (!preferences.clientEmbeds) return null;
  if (encrypted !== false && !preferences.encryptedClientEmbeds) return null;
  return (
    PROVIDERS.find((provider) => preferences[provider.preference] && provider.matches(url))
      ?.component ?? null
  );
}
