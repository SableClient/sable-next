import { Plugin, TextSelection } from 'prosemirror-state';

export function compositionInputRules(): Plugin {
  let pending = false;

  return new Plugin({
    props: {
      handleDOMEvents: {
        compositionend: () => {
          pending = true;
          return false;
        },
      },
    },
    view: () => ({
      update(view, previous) {
        if (!pending || view.composing || view.state.doc === previous.doc) return;
        pending = false;

        const { selection } = view.state;
        if (!(selection instanceof TextSelection)) return;
        const cursor = selection.$cursor;
        if (!cursor) return;

        view.someProp('handleTextInput', (handler) =>
          handler(view, cursor.pos, cursor.pos, '', () => view.state.tr)
        );
      },
    }),
  });
}
