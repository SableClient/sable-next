const OVERLAY_MARKER = 'sableOverlayBack';

export function isOverlayHistoryState(state: unknown): boolean {
  return Boolean(
    state && typeof state === 'object' && (state as Record<string, unknown>)[OVERLAY_MARKER]
  );
}

export function guardOverlayBack(onClose: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  window.history.pushState({ [OVERLAY_MARKER]: true }, '');

  const onPopState = (event: PopStateEvent): void => {
    if (isOverlayHistoryState(event.state)) return;
    window.removeEventListener('popstate', onPopState);
    onClose();
  };
  window.addEventListener('popstate', onPopState);

  return () => {
    window.removeEventListener('popstate', onPopState);
    if (isOverlayHistoryState(window.history.state)) window.history.back();
  };
}
