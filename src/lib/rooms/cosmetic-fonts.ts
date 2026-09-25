export interface CosmeticFont {
  name: string;
  family: string;
  aliases: readonly string[];
}

export const COSMETIC_FONTS: readonly CosmeticFont[] = [
  { name: 'Arial', family: 'var(--font-family-cosmetic-arial)', aliases: ['helvetica'] },
  { name: 'Verdana', family: 'var(--font-family-cosmetic-verdana)', aliases: ['geneva'] },
  {
    name: 'Trebuchet MS',
    family: 'var(--font-family-cosmetic-trebuchet)',
    aliases: ['trebuchet'],
  },
  { name: 'Georgia', family: 'var(--font-family-cosmetic-georgia)', aliases: ['serif'] },
  {
    name: 'Times New Roman',
    family: 'var(--font-family-cosmetic-times)',
    aliases: ['times'],
  },
  {
    name: 'Courier New',
    family: 'var(--font-family-cosmetic-courier)',
    aliases: ['courier', 'monospace', 'mono'],
  },
  {
    name: 'Comic Sans MS',
    family: 'var(--font-family-cosmetic-comic)',
    aliases: ['comic sans', 'comic neue', 'cursive'],
  },
  { name: 'Impact', family: 'var(--font-family-cosmetic-impact)', aliases: [] },
];

function normalise(name: string): string {
  return name.replaceAll(/["']/g, '').replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

export function cosmeticFont(name: string | null | undefined): CosmeticFont | null {
  if (!name) return null;
  const wanted = normalise(name);
  return (
    COSMETIC_FONTS.find(
      (font) => normalise(font.name) === wanted || font.aliases.includes(wanted)
    ) ?? null
  );
}
