import type { Attachment } from 'svelte/attachments';

export function whenVisible(onVisible: () => void, rootMargin = '300px'): Attachment<HTMLElement> {
  return (node) => {
    if (typeof IntersectionObserver === 'undefined') {
      onVisible();

      return;
    }

    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired || !entries.some((entry) => entry.isIntersecting)) return;
        fired = true;
        observer.disconnect();
        onVisible();
      },
      { rootMargin }
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  };
}
