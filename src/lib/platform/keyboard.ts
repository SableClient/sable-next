function keyboardInset(viewport: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)));
}

export function trackKeyboardInset(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  let frame = 0;
  let last = -1;

  const write = (): void => {
    frame = 0;
    const inset = keyboardInset(viewport);
    if (inset === last) return;
    last = inset;
    document.documentElement.style.setProperty('--keyboard-height', `${String(inset)}px`);
  };

  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(write);
  };

  write();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    document.documentElement.style.removeProperty('--keyboard-height');
  };
}
