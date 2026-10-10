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

function visible(char: string): boolean {
  return char.trim().length > 0;
}

function colourOf(index: number, total: number): string {
  return hslToHex((index / total) * (5 / 6), 1, 0.5);
}

export function rainbowHtml(text: string): string {
  const characters = graphemes(text);
  const coloured = characters.filter(visible).length;
  if (coloured === 0) return escapeHtml(text);

  let index = 0;
  return characters
    .map((char) => {
      if (!visible(char)) return escapeHtml(char);

      const colour = colourOf(index, coloured);
      index += 1;
      return `<span data-mx-color="${colour}">${escapeHtml(char)}</span>`;
    })
    .join('');
}

export function rainbowFormatted(html: string): string {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }

  const coloured = nodes.reduce(
    (count, node) => count + graphemes(node.data).filter(visible).length,
    0
  );
  if (coloured === 0) return html;

  let index = 0;
  for (const node of nodes) {
    const fragment = body.ownerDocument.createDocumentFragment();
    for (const char of graphemes(node.data)) {
      if (!visible(char)) {
        fragment.append(char);
        continue;
      }
      const span = body.ownerDocument.createElement('span');
      span.setAttribute('data-mx-color', colourOf(index, coloured));
      span.textContent = char;
      fragment.append(span);
      index += 1;
    }
    node.replaceWith(fragment);
  }
  return body.innerHTML;
}
