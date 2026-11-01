let titlebarHeight = $state(0);

export function trackTitlebarHeight(node: HTMLElement): () => void {
  const observer = new ResizeObserver(() => {
    titlebarHeight = node.offsetHeight;
  });
  observer.observe(node);
  return () => {
    observer.disconnect();
    titlebarHeight = 0;
  };
}

export function collisionPadding(padding = 0): Record<'top' | 'right' | 'bottom' | 'left', number> {
  return { top: padding + titlebarHeight, right: padding, bottom: padding, left: padding };
}
