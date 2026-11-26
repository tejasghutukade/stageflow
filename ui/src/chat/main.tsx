import "./chat.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./ChatApp";
import { registerBuiltinUiParts } from "./parts/builtins";

registerBuiltinUiParts();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
);
