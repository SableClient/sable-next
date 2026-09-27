import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import type {
  MarkView,
  MarkViewConstructor,
  NodeView,
  NodeViewConstructor,
} from 'prosemirror-view';

export interface EmoteMedia {
  cached: (url: string) => string | undefined;
  load: (url: string) => Promise<string>;
  hold: (url: string) => () => void;
}

abstract class AtomNodeView implements NodeView {
  dom: HTMLElement;
  protected selected = false;

  constructor(tag: string, className: string) {
    this.dom = document.createElement(tag);
    this.dom.className = className;
    this.dom.contentEditable = 'false';
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add('selected');
  }

  deselectNode(): void {
    this.selected = false;
    this.dom.classList.remove('selected');
  }
}

class MentionNodeView extends AtomNodeView {
  constructor(node: ProseMirrorNode, unlink: () => void) {
    super('span', 'composer-mention');
    const label = document.createElement('span');
    label.textContent = node.attrs.name as string;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'composer-mention-remove';
    remove.textContent = '×';
    remove.title = 'Remove mention link';
    remove.setAttribute('aria-label', 'Remove mention link');
    remove.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      unlink();
    });

    this.dom.append(label, remove);
    this.dom.title = node.attrs.userId as string;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLButtonElement;
  }
}

abstract class MediaNodeView extends AtomNodeView {
  private destroyed = false;
  private release: () => void;

  constructor(tag: string, className: string, url: string, alt: string, media: EmoteMedia) {
    super(tag, className);
    this.release = media.hold(url);

    const cached = media.cached(url);
    if (cached) {
      this.paint(cached, alt);
      return;
    }

    this.dom.textContent = alt;
    void media.load(url).then(
      (src) => {
        if (!this.destroyed) this.paint(src, alt);
      },
      () => {}
    );
  }

  protected paint(src: string, alt: string): void {
    const image = document.createElement('img');
    image.src = src;
    image.alt = alt;
    this.dom.replaceChildren(image);
  }

  destroy(): void {
    this.destroyed = true;
    this.release();
  }
}

class ImageNodeView extends MediaNodeView {
  constructor(node: ProseMirrorNode, media: EmoteMedia) {
    super(
      'span',
      'composer-image',
      node.attrs.src as string,
      (node.attrs.alt as string) || (node.attrs.src as string),
      media
    );
  }
}

class EmoticonNodeView extends AtomNodeView {
  private destroyed = false;
  private release: () => void;

  constructor(
    node: ProseMirrorNode,
    private media: EmoteMedia
  ) {
    super('span', 'composer-emoticon');
    const url = node.attrs.url as string;
    const label = `:${node.attrs.shortcode as string}:`;

    this.release = this.media.hold(url);
    const cached = this.media.cached(url);
    if (cached) {
      this.paint(cached, label);
      return;
    }

    this.dom.textContent = label;
    void this.media.load(url).then(
      (src) => {
        if (!this.destroyed) this.paint(src, label);
      },
      () => {}
    );
  }

  private paint(src: string, label: string): void {
    const image = document.createElement('img');
    image.src = src;
    image.alt = label;
    this.dom.replaceChildren(image);
  }

  destroy(): void {
    this.destroyed = true;
    this.release();
  }
}

export function composerNodeViews(
  media: EmoteMedia,
  unlinkMention: (position: number) => void = () => {}
): Record<string, NodeViewConstructor> {
  return {
    mention: (node, _view, getPos) =>
      new MentionNodeView(node, () => {
        const position = getPos();
        if (typeof position === 'number') unlinkMention(position);
      }),
    emoticon: (node) => new EmoticonNodeView(node, media),
    image: (node) => new ImageNodeView(node, media),
  };
}

function colorMarkView(
  mark: Mark,
  attribute: string,
  property: 'color' | 'backgroundColor'
): MarkView {
  const dom = document.createElement('span');
  const value = mark.attrs.value as string;
  dom.setAttribute(attribute, value);
  dom.style[property] = value;
  return { dom };
}

export const composerMarkViews: Record<string, MarkViewConstructor> = {
  color: (mark) => colorMarkView(mark, 'data-mx-color', 'color'),
  bg_color: (mark) => colorMarkView(mark, 'data-mx-bg-color', 'backgroundColor'),
};
