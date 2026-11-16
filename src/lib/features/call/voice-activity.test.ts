import { expect, test } from 'vitest';

import {
  SPEAKING_ATTACK_MS,
  SPEAKING_LEVEL,
  SPEAKING_RELEASE_MS,
  voiceGate,
} from './voice-activity';

const loud = SPEAKING_LEVEL * 2;

test('lights up once speech lasts past the attack time', () => {
  const gate = voiceGate();
  expect(gate(loud, 0)).toBe(false);
  expect(gate(loud, SPEAKING_ATTACK_MS - 1)).toBe(false);
  expect(gate(loud, SPEAKING_ATTACK_MS)).toBe(true);
});

test('ignores a click shorter than the attack time', () => {
  const gate = voiceGate();
  gate(loud, 0);
  expect(gate(0, 20)).toBe(false);
  expect(gate(loud, SPEAKING_ATTACK_MS + 20)).toBe(false);
});

test('holds through short pauses and clears after the release time', () => {
  const gate = voiceGate();
  gate(loud, 0);
  gate(loud, SPEAKING_ATTACK_MS);
  expect(gate(0, 100)).toBe(true);
  expect(gate(loud, 200)).toBe(true);
  expect(gate(0, 300)).toBe(true);
  expect(gate(0, 300 + SPEAKING_RELEASE_MS - 1)).toBe(true);
  expect(gate(0, 300 + SPEAKING_RELEASE_MS)).toBe(false);
});
