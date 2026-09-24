import { getContext, setContext } from 'svelte';

type AnchorLink = (anchor: string) => string;

const KEY = Symbol('settings-anchor-link');

export function provideSettingsAnchorLink(link: AnchorLink): void {
  setContext(KEY, link);
}

export function settingsAnchorLink(): AnchorLink | undefined {
  return getContext<AnchorLink | undefined>(KEY);
}
