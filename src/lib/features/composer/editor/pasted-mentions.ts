import { Fragment, Slice, type Node as ProseMirrorNode } from 'prosemirror-model';

import { composerSchema } from './schema';

const USER_ID =
  /(^|[\s(])(?:https:\/\/matrix\.to\/#\/)?(@[\w.=\-/+]+:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?)(?![\w:])/gu;

export type MentionName = (userId: string) => string | null;

function mentionLabel(userId: string, name: MentionName): string {
  const display = name(userId);
  if (!display) return userId;
  return display.startsWith('@') ? display : `@${display}`;
}

function splitText(node: ProseMirrorNode, name: MentionName): ProseMirrorNode[] {
  const text = node.text ?? '';
  const marks = node.marks;
  if (
    marks.some(
      (mark) => mark.type === composerSchema.marks.code || mark.type === composerSchema.marks.link
    )
  ) {
    return [node];
  }

  const parts: ProseMirrorNode[] = [];
  let at = 0;
  for (const match of text.matchAll(USER_ID)) {
    const start = match.index + match[1].length;
    const userId = match[2];
    if (start > at) parts.push(composerSchema.text(text.slice(at, start), marks));
    parts.push(
      composerSchema.nodes.mention.create({ userId, name: mentionLabel(userId, name) }, null, marks)
    );
    at = match.index + match[0].length;
  }
  if (parts.length === 0) return [node];
  if (at < text.length) parts.push(composerSchema.text(text.slice(at), marks));
  return parts;
}

function mapFragment(fragment: Fragment, inCode: boolean, name: MentionName): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText && !inCode) nodes.push(...splitText(node, name));
    else if (node.isText || node.isLeaf) nodes.push(node);
    else
      nodes.push(
        node.copy(mapFragment(node.content, inCode || Boolean(node.type.spec.code), name))
      );
  });
  return Fragment.fromArray(nodes);
}

export function withPastedMentions(slice: Slice, name: MentionName, inCode = false): Slice {
  if (inCode || !slice.content.textBetween(0, slice.content.size, '\n', '\n').includes('@')) {
    return slice;
  }
  return new Slice(mapFragment(slice.content, false, name), slice.openStart, slice.openEnd);
}
