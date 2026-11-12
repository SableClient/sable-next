import { hasIosUserAgent } from './os.js';

export function hasAndroidCompositionQuirk(): boolean {
  return typeof navigator !== 'undefined' && /Android \d/.test(navigator.userAgent);
}

export function hasIosKeyboardContextQuirk(): boolean {
  return hasIosUserAgent();
}
