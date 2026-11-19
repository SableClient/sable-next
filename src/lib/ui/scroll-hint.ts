import type { Attachment } from 'svelte/attachments';

const EDGE_TOLERANCE = 1;

function hint(horizontal: boolean): Attachment<HTMLElement> {
  const attribute = horizontal ? 'data-scroll-more-x' : 'data-scroll-more';
  const [start, end] = horizontal ? ['start', 'end'] : ['top', 'bottom'];

  return (element) => {
    const update = (): void => {
      const hidden = horizontal
        ? element.scrollWidth - element.clientWidth
        : element.scrollHeight - element.clientHeight;
      // scrollLeft is negative in RTL
      const scrolled = horizontal ? Math.abs(element.scrollLeft) : element.scrollTop;
      const edges: string[] = [];
      if (hidden > EDGE_TOLERANCE) {
        if (scrolled > EDGE_TOLERANCE) edges.push(start);
        if (scrolled < hidden - EDGE_TOLERANCE) edges.push(end);
      }

      if (edges.length > 0) element.setAttribute(attribute, edges.join(' '));
      else element.removeAttribute(attribute);
    };

    const resize = new ResizeObserver(update);
    const mutation = new MutationObserver(update);
    resize.observe(element);
    mutation.observe(element, { childList: true, subtree: true, characterData: true });
    element.addEventListener('scroll', update, { passive: true });
    update();

    return () => {
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener('scroll', update);
      element.removeAttribute(attribute);
    };
  };
}

export const scrollHint = hint(false);
export const scrollHintX = hint(true);
