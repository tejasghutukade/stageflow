import type { FunctionKind } from "../../api/functions";
import { FunctionEditorPage } from "./FunctionEditorPage";
import { FunctionsDirectoryPage } from "./FunctionsDirectoryPage";

export function FunctionsRedesign({ functionId, creating, kind }: { functionId?: string; creating?: boolean; kind?: FunctionKind }) {
  if (creating || functionId) {
    return (
      <FunctionEditorPage
        key={functionId ?? (creating ? `new:${kind ?? ""}` : "edit")}
        functionId={functionId}
        creating={creating === true}
        initialKind={kind}
      />
    );
  }
  return <FunctionsDirectoryPage />;
}
