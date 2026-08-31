export interface CursorAnchor {
  getBoundingClientRect: () => DOMRect;
}

export function cursorAnchor(event: MouseEvent): CursorAnchor {
  const { clientX, clientY } = event;
  return { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) };
}
