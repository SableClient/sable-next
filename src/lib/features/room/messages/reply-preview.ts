import type { TimelineItemContentView } from '#src/generated/protocol';

const SPOILER = 'data-mx-spoiler';

export type ReplyVersion = { of: string; body: string; html: string | null };

function previewText(body: string, html: string | null): string {
  if (html === null) return body;
  const parsed = new DOMParser().parseFromString(html, 'text/html').body;
  for (const spoiler of parsed.querySelectorAll(`[${SPOILER}]`)) spoiler.replaceWith('[Spoiler]');
  let text = '';
  const lineBreak = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === 'BR') {
      text += '\n';
      return;
    }
    if (node.tagName === 'IMG') {
      text += node.getAttribute('alt') ?? '';
      return;
    }
    const block = /^(?:P|DIV|PRE|BLOCKQUOTE|H[1-6]|LI|TR)$/.test(node.tagName);
    if (block) lineBreak();
    node.childNodes.forEach(visit);
    if (block) lineBreak();
  };
  parsed.childNodes.forEach(visit);
  return text.replace(/\n+$/, '') || body;
}

export function replyPreviewBody(content: TimelineItemContentView): string {
  switch (content.kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return content.caption === null
        ? content.filename
        : previewText(content.caption, content.html);
    case 'message':
      return previewText(content.body, content.html);
    case 'gallery':
      return content.body === ''
        ? content.items.map((item) => item.filename).join(', ')
        : previewText(content.body, content.html);
    case 'sticker':
    case 'location':
      return content.body;
    case 'poll':
      return content.poll.question;
    default:
      return '';
  }
}
