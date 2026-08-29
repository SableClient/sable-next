import { describe, expect, it } from 'vitest';

import { pickBadgeStrategy } from './badge.js';

describe('pickBadgeStrategy', () => {
  it('uses the Tauri window API on desktop', () => {
    expect(pickBadgeStrategy(true, 'linux', false)).toBe('tauri-window');
    expect(pickBadgeStrategy(true, 'windows', false)).toBe('tauri-window');
    expect(pickBadgeStrategy(true, 'macos', false)).toBe('tauri-window');
  });

  it('has no desktop badge concept on mobile Tauri builds', () => {
    expect(pickBadgeStrategy(true, 'android', false)).toBe('none');
    expect(pickBadgeStrategy(true, 'ios', false)).toBe('none');
  });

  it('falls back to the web Badging API outside Tauri when it exists', () => {
    expect(pickBadgeStrategy(false, '', true)).toBe('web-app-badge');
    expect(pickBadgeStrategy(false, '', false)).toBe('none');
  });
});
