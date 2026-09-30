import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { memo, type FC } from "react";

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1 className={["aui-md-h1", className].filter(Boolean).join(" ")} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={["aui-md-h2", className].filter(Boolean).join(" ")} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={["aui-md-h3", className].filter(Boolean).join(" ")} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={["aui-md-h4", className].filter(Boolean).join(" ")} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={["aui-md-h5", className].filter(Boolean).join(" ")} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6 className={["aui-md-h6", className].filter(Boolean).join(" ")} {...props} />
  ),
  p: ({ className, ...props }) => (
    <p className={["aui-md-p", className].filter(Boolean).join(" ")} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a className={["aui-md-a", className].filter(Boolean).join(" ")} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={["aui-md-blockquote", className].filter(Boolean).join(" ")}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={["aui-md-ul", className].filter(Boolean).join(" ")} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={["aui-md-ol", className].filter(Boolean).join(" ")} {...props} />
  ),
  hr: ({ className, ...props }) => (
    <hr className={["aui-md-hr", className].filter(Boolean).join(" ")} {...props} />
  ),
  table: ({ className, ...props }) => (
    <table className={["aui-md-table", className].filter(Boolean).join(" ")} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th className={["aui-md-th", className].filter(Boolean).join(" ")} {...props} />
  ),
  td: ({ className, ...props }) => (
    <td className={["aui-md-td", className].filter(Boolean).join(" ")} {...props} />
  ),
  tr: ({ className, ...props }) => (
    <tr className={["aui-md-tr", className].filter(Boolean).join(" ")} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={["aui-md-li", className].filter(Boolean).join(" ")} {...props} />
  ),
  sup: ({ className, ...props }) => (
    <sup className={["aui-md-sup", className].filter(Boolean).join(" ")} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={["aui-md-pre", className].filter(Boolean).join(" ")} {...props} />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={[!isCodeBlock ? "aui-md-inline-code" : undefined, className]
          .filter(Boolean)
          .join(" ")}
        {...props}
      />
    );
  },
});

const MarkdownTextImpl: FC = () => (
  <MarkdownTextPrimitive className="aui-md" components={defaultComponents} defer />
);

export const MarkdownText = memo(MarkdownTextImpl);
