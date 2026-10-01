import type { CoreClient } from '#lib/core/client.svelte.js';
import { cachedMediaUrl, holdMediaUrl, loadMediaUrl, retryMediaUrl } from '#lib/ui/media-url.js';

const RETRIES = 2;

export class FormattedBodyImages {
  constructor(
    private readonly core: CoreClient,
    private readonly fallbackLabel: (image: HTMLImageElement, emoticon: boolean) => string,
    private readonly paint: (image: HTMLImageElement, url: string) => void
  ) {}

  defer(html: string): string {
    return html.replace(
      /(<img\b(?:[^>"']|"[^"]*"|'[^']*')*?)\s+src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      '$1 data-sable-src=$2'
    );
  }

  attach(node: HTMLElement, concealed: boolean): () => void {
    if (concealed) return this.#conceal(node);
    const releases = this.#resolve(node);
    return () => {
      for (const release of releases) release();
    };
  }

  #conceal(node: HTMLElement): () => void {
    const labels: HTMLElement[] = [];
    const images: HTMLImageElement[] = [];
    for (const image of node.querySelectorAll('img')) {
      if (image.hidden) continue;
      image.hidden = true;
      images.push(image);
      const text = this.fallbackLabel(image, this.#isEmoticon(image));
      if (!text) continue;
      const label = document.createElement('span');
      label.className = 'concealed-image';
      label.textContent = text;
      image.after(label);
      labels.push(label);
    }
    return () => {
      for (const label of labels) label.remove();
      for (const image of images) image.hidden = false;
    };
  }

  #resolve(node: HTMLElement): (() => void)[] {
    const releases: (() => void)[] = [];
    for (const image of node.querySelectorAll('img')) {
      if (image.dataset.mediaHandled !== undefined) continue;
      image.dataset.mediaHandled = '';
      const source = this.#source(image);
      const emoticon = this.#isEmoticon(image);
      if (emoticon) image.dataset.mxEmoticon = '';
      if (emoticon && !/^mxc:\/\/[^/?#\s]+\/[A-Za-z0-9_-]+$/u.test(source)) {
        image.replaceWith(this.fallbackLabel(image, true));
        continue;
      }
      const scheme = source.slice(0, source.indexOf(':') + 1).toLowerCase();
      if (scheme === 'http:' || scheme === 'https:') {
        image.onerror = () => {
          console.warn('[sable media] remote image unavailable', source);
          image.replaceWith(this.fallbackLabel(image, emoticon));
        };
        image.src = source;
        continue;
      }
      if (scheme !== 'mxc:') {
        image.replaceWith(this.fallbackLabel(image, emoticon));
        continue;
      }
      const [width, height] = emoticon ? [0, 0] : [640, 480];
      image.dataset.mediaPending = '';
      image.removeAttribute('src');
      releases.push(holdMediaUrl(this.core, source, width, height));
      const cached = cachedMediaUrl(this.core, source, width, height);
      if (cached !== undefined) {
        this.paint(image, cached);
        continue;
      }
      this.#load(image, source, emoticon, width, height, 0);
    }
    return releases;
  }

  #load(
    image: HTMLImageElement,
    source: string,
    emoticon: boolean,
    width: number,
    height: number,
    retry: number
  ): void {
    void (retry === 0 ? loadMediaUrl : retryMediaUrl)(this.core, source, width, height)
      .then((url) => {
        if (image.isConnected) this.paint(image, url);
      })
      .catch((error: unknown) => {
        if (!image.isConnected) return;
        if (retry < RETRIES) {
          setTimeout(
            () => {
              this.#load(image, source, emoticon, width, height, retry + 1);
            },
            2 ** (retry + 1) * 1000
          );
          return;
        }
        console.warn('[sable media] inline image unavailable', source, error);
        image.replaceWith(this.fallbackLabel(image, emoticon));
      });
  }

  #source(image: HTMLImageElement): string {
    return image.dataset.sableSrc ?? image.getAttribute('src') ?? '';
  }

  #isEmoticon(image: HTMLImageElement): boolean {
    return (
      image.dataset.mxEmoticon !== undefined ||
      (this.#source(image).startsWith('mxc:') &&
        (image.getAttribute('alt')?.startsWith(':') === true ||
          image.getAttribute('title')?.startsWith(':') === true ||
          (image.hasAttribute('height') && image.hasAttribute('title'))))
    );
  }
}
