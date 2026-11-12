import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

import { SETTINGS_ACCOUNT_SECTION } from '#lib/settings/registry.js';
import { isPlainClick } from '#lib/ui/plain-click.js';

export function defaultSettingsSection(): string {
  return SETTINGS_ACCOUNT_SECTION;
}

/** Opens settings over the calling page, which stays mounted behind it. */
export function openSettingsOver(event: MouseEvent, section: string): void {
  if (!isPlainClick(event)) return;

  event.preventDefault();
  showSettingsOver(section);
}

export function showSettingsOver(section: string): void {
  void goto(resolve(`settings/${section}`), { shallow: true, state: { settings: { section } } });
}

/** Section-to-section moves replace, so closing returns to the opening page. */
export function selectSettingsSection(event: MouseEvent, section: string): void {
  if (!isPlainClick(event)) return;

  event.preventDefault();

  void goto(resolve(`settings/${section}`), {
    shallow: true,
    replace: true,
    state: { settings: { section } },
  });
}

/** Follows a settings link posted in a room. Phones navigate instead. */
export function followSettingsLink(
  event: MouseEvent,
  section: string,
  focus: string | undefined,
  shallow: boolean
): void {
  if (!isPlainClick(event)) return;

  event.preventDefault();
  const query = focus === undefined ? '' : `?focus=${encodeURIComponent(focus)}`;
  if (shallow) {
    void goto(resolve(`settings/${section}${query}`), {
      shallow: true,
      state: { settings: { section, focus } },
    });
    return;
  }

  void goto(resolve(`settings/${section}${query}`));
}
