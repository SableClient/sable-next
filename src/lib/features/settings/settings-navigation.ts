import { goto, pushState, replaceState } from '$app/navigation';
import { resolve } from '$app/paths';

import { SETTINGS_DEVICES_SECTION, settingsCategories } from '$lib/settings/registry';

export function defaultSettingsSection(): string {
  return settingsCategories[0]?.id ?? SETTINGS_DEVICES_SECTION;
}

/** Modified clicks keep the link's own behaviour. */
function plainClick(event: MouseEvent): boolean {
  return !event.shiftKey && !event.metaKey && !event.ctrlKey && event.button === 0;
}

/** Opens settings over the calling page, which stays mounted behind it. */
export function openSettingsOver(event: MouseEvent, section: string): void {
  if (!plainClick(event)) return;

  event.preventDefault();
  pushState(resolve(`/settings/${section}`), { settings: { section } });
}

/** Section-to-section moves replace, so closing returns to the opening page. */
export function selectSettingsSection(event: MouseEvent, section: string): void {
  if (!plainClick(event)) return;

  event.preventDefault();
  replaceState(resolve(`/settings/${section}`), { settings: { section } });
}

/** Follows a settings link posted in a room. Phones navigate instead. */
export function followSettingsLink(
  event: MouseEvent,
  section: string,
  focus: string | undefined,
  shallow: boolean
): void {
  if (!plainClick(event)) return;

  event.preventDefault();
  const query = focus === undefined ? '' : `?focus=${encodeURIComponent(focus)}`;
  if (shallow) {
    pushState(resolve(`/settings/${section}${query}`), { settings: { section } });
    return;
  }

  void goto(resolve(`/settings/${section}${query}`));
}
