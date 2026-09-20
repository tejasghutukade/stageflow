import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeAgent } from "../../../src/agent/fakeAgent.js";
import { createCompletedOnlyStageHandle, runStageViaOpen, type AgentPort } from "../../../src/agent/port.js";
import { attemptArtifactsDir } from "../../../src/runstore/workspaceLayout.js";

/**
 * Fake execution backend for `tests/fixtures/a2a/{a2a,supplier}.yaml`: waits at the free_text
 * `clarify` gate, then completes `final_report` with a real `assessment.md` written to the
 * attempt's artifact directory (so `verify: type: artifact` and A2A result-freezing both see it).
 * Shared by every A2A test that runs the canonical supplier-assessment publication, so its
 * behavior only needs to match that fixture's stage IDs and gates in one place.
 */
export function supplierAgent(): AgentPort {
  return {
    openStage(input) {
      if (input.stage.id === "clarify") {
        return new FakeAgent({
          type: "wait_then_emit",
          waitRequests: [{ kind: "free_text", message: "Is certification mandatory?", id: "q-" + input.task.id }],
          envelope: { status: "success", summary: "Clarified", artifacts: [], payload: { supplier: "Northstar Packaging" } },
        }).openStage(input);
      }
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => {
          const dir = attemptArtifactsDir(input.roots.runWorkspaceDir, "final_report", 1);
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, "assessment.md"), "# Supplier assessment\napproved\n");
          return {
            ok: true,
            envelope: {
              status: "success",
              summary: "Assessment complete",
              artifacts: ["stages/final_report/attempts/1/artifacts/assessment.md"],
              payload: { recommendation: "approve" },
            },
          };
        },
      });
    },
    async runStage(input) {
      return runStageViaOpen(this, input);
    },
  };
}

/**
 * Fake execution backend for `tests/fixtures/a2a/gated.yaml`: parks forever at the operator-only
 * `confirm` gate on the `approve` stage. Used to exercise the boundary that a caller can never
 * answer an operator-only gate, even with a forged handle — the run is never meant to finish here.
 */
export function gatedAgent(): AgentPort {
  const approve = new FakeAgent({
    type: "wait_then_emit",
    waitRequests: [{ kind: "confirm", message: "Approve this request?", id: "g-1" }],
    envelope: { status: "success", summary: "Approved", artifacts: [], payload: { note: "please approve" } },
  });
  return {
    openStage(input) {
      return approve.openStage(input);
    },
    async runStage(input) {
      return runStageViaOpen(this, input);
    },
  };
}
