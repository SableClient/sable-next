const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number): string => {
    const k = (offset + hue * 12) % 12;
    const value = lightness - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return text.split('');

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

export function rainbowHtml(text: string): string {
  const characters = graphemes(text);
  const coloured = characters.filter((char) => char.trim().length > 0).length;
  if (coloured === 0) return escapeHtml(text);

  let index = 0;
  return characters
    .map((char) => {
      if (char.trim().length === 0) return escapeHtml(char);

      const hue = (index / coloured) * (5 / 6);
      index += 1;
      return `<span data-mx-color="${hslToHex(hue, 1, 0.5)}">${escapeHtml(char)}</span>`;
    })
    .join('');
}
