import type { Attachment } from 'svelte/attachments';

export function whenVisible(
  onVisible: () => void,
  rootMargin = '300px',
  dwellMs = 0
): Attachment<HTMLElement> {
  return (node) => {
    if (typeof IntersectionObserver === 'undefined') {
      onVisible();

      return;
    }

    let fired = false;
    let dwell: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      fired = true;
      observer.disconnect();
      onVisible();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired) return;
        if (!entries.some((entry) => entry.isIntersecting)) {
          clearTimeout(dwell);
          dwell = undefined;
          return;
        }
        if (dwellMs === 0) fire();
        else dwell ??= setTimeout(fire, dwellMs);
      },
      { rootMargin }
    );
    observer.observe(node);

    return () => {
      clearTimeout(dwell);
      observer.disconnect();
    };
  };
}
