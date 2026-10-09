import type { Attachment } from 'svelte/attachments';

const EDGE_TOLERANCE = 1;

export const scrollHint: Attachment<HTMLElement> = (element) => {
  const update = (): void => {
    const hidden = element.scrollHeight - element.clientHeight;
    const edges: string[] = [];
    if (hidden > EDGE_TOLERANCE) {
      if (element.scrollTop > EDGE_TOLERANCE) edges.push('top');
      if (element.scrollTop < hidden - EDGE_TOLERANCE) edges.push('bottom');
    }

    if (edges.length > 0) element.dataset.scrollMore = edges.join(' ');
    else delete element.dataset.scrollMore;
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
    delete element.dataset.scrollMore;
  };
};
