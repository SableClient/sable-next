import { expect, test } from 'vitest';

import { cosmeticFont } from './cosmetic-fonts';

test('a known font resolves by name or alias, whatever its quoting and case', () => {
  expect(cosmeticFont('Comic Sans MS')?.name).toBe('Comic Sans MS');
  expect(cosmeticFont('"comic  sans"')?.name).toBe('Comic Sans MS');
  expect(cosmeticFont('MONO')?.name).toBe('Courier New');
});

test('an unknown font is ignored rather than injected into a style', () => {
  expect(cosmeticFont('Papyrus')).toBeNull();
  expect(cosmeticFont('x; background: red')).toBeNull();
  expect(cosmeticFont(null)).toBeNull();
});
