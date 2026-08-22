import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';

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
  constructor(node: ProseMirrorNode) {
    super('span', 'composer-mention');
    this.dom.textContent = node.attrs.name as string;
    this.dom.title = node.attrs.userId as string;
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

export function composerNodeViews(media: EmoteMedia): Record<string, NodeViewConstructor> {
  return {
    mention: (node) => new MentionNodeView(node),
    emoticon: (node) => new EmoticonNodeView(node, media),
  };
}
