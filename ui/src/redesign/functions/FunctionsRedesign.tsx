import { FunctionEditorPage } from "./FunctionEditorPage";
import { FunctionsDirectoryPage } from "./FunctionsDirectoryPage";

export function FunctionsRedesign({ functionId, creating }: { functionId?: string; creating?: boolean }) {
  if (creating || functionId) {
    return (
      <FunctionEditorPage
        key={functionId ?? (creating ? "new" : "edit")}
        functionId={functionId}
        creating={creating === true}
      />
    );
  }
  return <FunctionsDirectoryPage />;
}
