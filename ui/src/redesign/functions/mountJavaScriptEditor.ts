import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView, basicSetup } from "codemirror";

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "var(--sf-running)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--sf-ok)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--sf-needs)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--sf-text-3)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName))], color: "var(--sf-text-1)", fontWeight: "600" },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--sf-text-1)" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "var(--sf-text-1)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "var(--sf-text-2)" },
  { tag: [tags.regexp, tags.escape], color: "var(--sf-needs)" },
  { tag: tags.invalid, color: "var(--sf-fail)" },
]);

const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--sf-panel)",
      color: "var(--sf-text-1)",
      fontSize: "12px",
      minHeight: "320px",
      maxHeight: "560px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--sf-font-mono, ui-monospace, monospace)", lineHeight: "1.65", overflow: "auto" },
    ".cm-content": { padding: "10px 0", caretColor: "var(--sf-text-1)" },
    ".cm-line": { padding: "0 12px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--sf-text-1)" },
    ".cm-gutters": { backgroundColor: "var(--sf-panel)", color: "var(--sf-text-3)", border: "none", borderRight: "1px solid var(--sf-hairline)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px", minWidth: "32px" },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--sf-text-2)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--sf-running-bg)" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(108, 166, 255, 0.28)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(255, 255, 255, 0.1)", outline: "none" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--sf-raised)", border: "none", color: "var(--sf-text-2)" },
    ".cm-tooltip": { backgroundColor: "var(--sf-raised)", border: "1px solid var(--sf-hairline-strong)", color: "var(--sf-text-1)" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--sf-font-mono, ui-monospace, monospace)", fontSize: "12px" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--sf-hairline-strong)", color: "var(--sf-text-1)" },
    ".cm-completionIcon": { display: "none" },
    ".cm-panels": { backgroundColor: "var(--sf-raised)", color: "var(--sf-text-1)" },
  },
  { dark: true },
);

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
        theme,
        syntaxHighlighting(highlight),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
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
