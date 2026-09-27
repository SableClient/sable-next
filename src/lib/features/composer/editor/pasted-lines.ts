const BLOCKS =
  'address,article,aside,blockquote,dd,details,div,dl,dt,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul';

export function lineDivsAsBreaks(html: string): string {
  if (html.includes('data-pm-slice')) return html;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const lines = Array.from(body.querySelectorAll('div')).reverse();
  if (lines.length === 0) return html;

  for (const line of lines) {
    if (line.querySelector(BLOCKS)) continue;
    if (line.lastChild?.nodeName === 'BR') line.lastChild.remove();
    const content: Node[] = Array.from(line.childNodes);
    if (line.nextSibling) content.push(body.ownerDocument.createElement('br'));
    line.replaceWith(...content);
  }
  return body.innerHTML;
}
