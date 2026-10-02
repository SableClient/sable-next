import type { Component } from 'svelte';

import type { UrlPreviewView } from '#src/generated/protocol';

import { preferences } from '#lib/settings/preferences.svelte.js';
import type { BooleanPreference } from '#lib/settings/registry.js';

import { parseInstagramLink } from './instagram';
import InstagramEmbed from './InstagramEmbed.svelte';
import { parseTiktokLink } from './tiktok';
import TiktokEmbed from './TiktokEmbed.svelte';
import { parseYoutubeLink } from './youtube';
import YoutubeEmbed from './YoutubeEmbed.svelte';

export interface EmbedProps {
  url: string;
  encrypted: boolean | null;
  bundled?: UrlPreviewView | null;
}

export type EmbedComponent = Component<EmbedProps>;

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
  {
    preference: 'tiktokEmbeds',
    matches: (url) => parseTiktokLink(url) !== null,
    component: TiktokEmbed,
  },
  {
    preference: 'instagramEmbeds',
    matches: (url) => parseInstagramLink(url) !== null,
    component: InstagramEmbed,
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
