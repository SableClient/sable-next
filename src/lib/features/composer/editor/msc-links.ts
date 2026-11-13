import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';

import { composerSchema } from './schema';

const MSC_REFERENCE = /(?<![\p{L}\p{N}_])MSC(\d{1,5})(?![\p{L}\p{N}_])/giu;

export function mscHref(number: string): string {
  return `https://github.com/matrix-org/matrix-spec-proposals/pull/${number}`;
}

export function isMscLink(text: string, href: string): boolean {
  const match = /^MSC(\d{1,5})$/iu.exec(text);
  return match?.[1] !== undefined && mscHref(match[1]) === href;
}

export function linkMscs(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isLeaf || node.type.spec.code) return node;

  const { link, code } = composerSchema.marks;
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    if (!child.isText) {
      children.push(linkMscs(child));
      return;
    }
    const text = child.text ?? '';
    if (link.isInSet(child.marks) || code.isInSet(child.marks)) {
      children.push(child);
      return;
    }
    let offset = 0;
    for (const match of text.matchAll(MSC_REFERENCE)) {
      const number = match[1];
      if (match.index > offset) {
        children.push(composerSchema.text(text.slice(offset, match.index), child.marks));
      }
      children.push(
        composerSchema.text(match[0], link.create({ href: mscHref(number) }).addToSet(child.marks))
      );
      offset = match.index + match[0].length;
    }
    if (offset === 0) children.push(child);
    else if (offset < text.length) {
      children.push(composerSchema.text(text.slice(offset), child.marks));
    }
  });

  return node.copy(Fragment.fromArray(children));
}
