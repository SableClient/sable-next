export function hasAndroidCompositionQuirk(): boolean {
  return typeof navigator !== 'undefined' && /Android \d/.test(navigator.userAgent);
}
