import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";

export function mountJavaScriptEditor(
  parent: HTMLElement,
  value: string,
  onChange: (next: string) => void,
): { destroy: () => void; setValue: (next: string) => void } {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        javascript(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": {
            backgroundColor: "var(--sf-panel)",
            color: "var(--sf-text-1)",
            fontSize: "var(--font-size-2)",
          },
          ".cm-content": { fontFamily: "var(--sf-font-mono, ui-monospace, monospace)" },
          ".cm-gutters": {
            backgroundColor: "var(--sf-panel)",
            color: "var(--sf-text-3)",
            border: "none",
          },
        }),
      ],
    }),
  });
  return {
    destroy: () => view.destroy(),
    setValue: (next: string) => {
      const current = view.state.doc.toString();
      if (next === current) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    },
  };
}
