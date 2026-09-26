import MarkdownIt from 'markdown-it';

const renderer = MarkdownIt('commonmark', { html: false, linkify: true, breaks: true })
  .enable(['strikethrough', 'linkify'])
  .disable('image');

export function topicHtml(topic: string): string {
  return renderer.render(topic).trim();
}
