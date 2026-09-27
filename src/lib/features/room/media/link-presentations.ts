import type { Component } from 'svelte';

import type { UrlPreviewView } from '#src/generated/protocol';

import { parseYoutubeLink } from './embeds/youtube';
import YoutubeLinkPreview from './YoutubeLinkPreview.svelte';

export interface LinkPresentationProps {
  url: string;
  preview: UrlPreviewView;
  mediaHidden: boolean;
}

type LinkPresentation = Component<LinkPresentationProps>;

interface LinkPresentationProvider {
  matches: (url: string, preview: UrlPreviewView) => boolean;
  component: LinkPresentation;
}

const PROVIDERS: LinkPresentationProvider[] = [
  {
    matches: (url) => parseYoutubeLink(url) !== null,
    component: YoutubeLinkPreview,
  },
];

export function findLinkPresentation(
  url: string,
  preview: UrlPreviewView
): LinkPresentation | null {
  return PROVIDERS.find((provider) => provider.matches(url, preview))?.component ?? null;
}
