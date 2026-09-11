import { expect, test } from 'vitest';

import GlobeSimpleIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
import HashStraightIcon from 'phosphor-svelte/lib/HashStraightIcon';
import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';

import { roomIconComponent, roomIconOverlay } from './room-icon.js';

test('a regular room keeps its hash glyph and carries the join rule as a badge', () => {
  expect(roomIconComponent({ joinRule: 'invite' })).toBe(HashStraightIcon);
  expect(roomIconOverlay({ joinRule: 'invite' })).toBe('lock');
  expect(roomIconOverlay({ joinRule: 'public' })).toBe('globe');
});

test('a space and a voice room carry the join rule in the glyph, not a badge', () => {
  expect(roomIconComponent({ isSpace: true })).toBe(SquaresFourIcon);
  expect(roomIconComponent({ isSpace: true, joinRule: 'public' })).toBe(GlobeSimpleIcon);
  expect(roomIconComponent({ isVoice: true })).toBe(SpeakerHighIcon);
  expect(roomIconComponent({ isVoice: true, joinRule: 'knock' })).toBe(LockSimpleIcon);
  expect(roomIconOverlay({ isSpace: true, joinRule: 'public' })).toBeUndefined();
  expect(roomIconOverlay({ isVoice: true, joinRule: 'invite' })).toBeUndefined();
});

test('a restricted rule reads as neither open nor locked', () => {
  expect(roomIconOverlay({ joinRule: 'restricted' })).toBeUndefined();
  expect(roomIconOverlay({ joinRule: null })).toBeUndefined();
});
