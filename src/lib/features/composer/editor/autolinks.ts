import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { composerSchema } from './schema';

const { link, code } = composerSchema.marks;

const BARE_URL =
  /(?<![^\p{White_Space}(￼])(?:https?:\/\/|www\.)[^\p{White_Space}￼<>()]*[^\p{White_Space}￼<>().,;:!?'"]/gu;

const MASK = '￼';

interface Span {
  from: number;
  to: number;
  href: string;
}

interface LinkRun extends Span {
  auto: boolean;
}

function isAddressOf(label: string, href: string): boolean {
  if (!/^(?:https?:\/\/|www\.)/u.test(label)) return false;
  const target = label.startsWith('www.') ? `https://${label}` : label;
  return target.startsWith(href) || href.startsWith(target);
}

function inspect(block: ProseMirrorNode, start: number): { spans: Span[]; runs: LinkRun[] } {
  let text = '';
  const runs: (LinkRun & { label: string })[] = [];
  let open: (LinkRun & { label: string }) | null = null;

  block.forEach((child, offset) => {
    const position = start + offset;
    if (!child.isText) {
      text += MASK;
      open = null;
      return;
    }
    const value = child.text ?? '';
    text += code.isInSet(child.marks) ? MASK.repeat(value.length) : value;

    const mark = link.isInSet(child.marks);
    if (!mark) {
      open = null;
      return;
    }
    const href = mark.attrs.href as string;
    if (open?.href === href && open.to === position) {
      open.to = position + value.length;
      open.label += value;
      return;
    }
    open = { from: position, to: position + value.length, href, auto: false, label: value };
    runs.push(open);
  });

  for (const run of runs) run.auto = isAddressOf(run.label, run.href);

  const spans = [...text.matchAll(BARE_URL)].map((match) => ({
    from: start + match.index,
    to: start + match.index + match[0].length,
    href: match[0].startsWith('www.') ? `https://${match[0]}` : match[0],
  }));
  return { spans, runs };
}

export function reconcileLinks(state: EditorState): Transaction | null {
  const tr = state.tr;

  state.doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;

    const { spans, runs } = inspect(node, position + 1);
    const same = (run: Span, span: Span) =>
      run.from === span.from && run.to === span.to && run.href === span.href;

    for (const run of runs) {
      if (run.auto && !spans.some((span) => same(run, span))) {
        tr.removeMark(run.from, run.to, link);
      }
    }
    for (const span of spans) {
      if (runs.some((run) => run.auto && same(run, span))) continue;
      if (runs.some((run) => !run.auto && run.from < span.to && run.to > span.from)) continue;
      tr.removeMark(span.from, span.to, link).addMark(
        span.from,
        span.to,
        link.create({ href: span.href })
      );
    }
    return false;
  });

  return tr.steps.length > 0 ? tr : null;
}

function textOf(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', MASK);
}

export function autolinks(): Plugin {
  let seen = '';

  const reconcile = (view: EditorView) => {
    if (view.composing) return;
    const text = textOf(view.state);
    if (text === seen) return;
    seen = text;
    const tr = reconcileLinks(view.state);
    if (tr) view.dispatch(tr.setMeta('addToHistory', false));
  };

  return new Plugin({
    props: {
      handleDOMEvents: {
        compositionend: (view) => {
          setTimeout(() => {
            if (!view.isDestroyed) reconcile(view);
          }, 50);
          return false;
        },
      },
    },
    view: () => ({ update: reconcile }),
  });
}
