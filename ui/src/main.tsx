import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./console.css";
import "./redesign/tailwind.css";
import "./redesign/tokens.css";
import "./redesign/shell.css";
import "./redesign/slice3.css";
import "./redesign/editor/editor.css";
import "./redesign/workshop/workshop.css";
import "./redesign/runs.css";
import "./redesign/slice5.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
