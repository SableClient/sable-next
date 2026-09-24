import { getContext, setContext } from 'svelte';

interface SettingsAnchors {
  link: (anchor: string) => string;
  highlighted: () => string | null;
}

const KEY = Symbol('settings-anchors');

export function provideSettingsAnchors(anchors: SettingsAnchors): void {
  setContext(KEY, anchors);
}

export function settingsAnchors(): SettingsAnchors | undefined {
  return getContext<SettingsAnchors | undefined>(KEY);
}
