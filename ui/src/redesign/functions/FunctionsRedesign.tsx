import { FunctionEditorPage } from "./FunctionEditorPage";
import { FunctionsDirectoryPage } from "./FunctionsDirectoryPage";

export function FunctionsRedesign({ functionId, creating }: { functionId?: string; creating?: boolean }) {
  if (creating || functionId) return <FunctionEditorPage functionId={functionId} creating={creating === true} />;
  return <FunctionsDirectoryPage />;
}
