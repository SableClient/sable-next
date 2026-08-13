export const settingsOverlay = $state({ open: false });

export function openSettingsOverlay(): void {
  settingsOverlay.open = true;
}

export function closeSettingsOverlay(): void {
  settingsOverlay.open = false;
}
