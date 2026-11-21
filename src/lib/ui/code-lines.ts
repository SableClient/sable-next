import './code-lines.css';

export function splitCodeLines(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const fragment = doc.createDocumentFragment();
  let currentLine = createLine(doc);
  fragment.append(currentLine);

  let openWrappers: Element[] = [];
  const ancestorTemplates: Element[] = [];

  function startNextLine(): void {
    currentLine = createLine(doc);
    fragment.append('\n', currentLine);
    openWrappers = [];
  }

  function ensureWrappers(): Element {
    let target: Element = currentLine;
    for (let i = 0; i < ancestorTemplates.length; i++) {
      target = openWrappers[i] ??= target.appendChild(
        ancestorTemplates[i].cloneNode(false) as Element
      );
    }
    return target;
  }

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.nodeValue ?? '').split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) startNextLine();
        if (parts[i].length > 0) ensureWrappers().appendChild(doc.createTextNode(parts[i]));
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (!element.textContent.includes('\n')) {
        ensureWrappers().appendChild(element);
        return;
      }
      const depth = ancestorTemplates.length;
      ancestorTemplates.push(element);
      for (const child of [...element.childNodes]) walk(child);
      ancestorTemplates.pop();
      openWrappers.length = Math.min(openWrappers.length, depth);
    }
  }

  for (const child of [...container.childNodes]) walk(child);
  const digits = Math.max(2, String(fragment.childElementCount).length);
  container.style.setProperty('--code-line-digits', String(digits));
  container.classList.add('code-lines');
  container.replaceChildren(fragment);
}

function createLine(doc: Document): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = 'code-line';
  return span;
}
