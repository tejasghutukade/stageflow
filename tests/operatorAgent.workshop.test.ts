import { describe, expect, it } from "vitest";
import {
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  emptyDraftPackage,
  readDraftFromContext,
  WORKSHOP_AUTHOR_GREETING,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "../src/operatorAgent/index.js";
import {
  createDraftPackage,
  validateDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const MODEL = "anthropic/claude-sonnet-4-5";
const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

describe("Operator Agent Host — Workshop Author", () => {
  it("registers Workshop Author as the first profile", () => {
    const host = createWorkshopOperatorHost();
    const profiles = host.listProfiles();
    expect(profiles.map((p) => p.id)).toEqual([WORKSHOP_AUTHOR_PROFILE_ID]);
    expect(profiles[0]!.greeting).toBe(WORKSHOP_AUTHOR_GREETING);
  });

  it("Accept applies a proposal to the virtual draft; Reject leaves it unchanged", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );

    const events = await session.send("intake form review");
    expect(events.some((e) => e.type === "proposal")).toBe(true);
    const pending = session.getPendingProposal();
    expect(pending).not.toBeNull();
    expect(pending!.summary).toMatch(/Add stage/i);

    expect(session.rejectProposal(pending!.id)).toBe(true);
    expect(session.getPendingProposal()).toBeNull();
    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );

    await session.send("intake form review");
    const again = session.getPendingProposal();
    expect(again).not.toBeNull();
    expect(session.acceptProposal(again!.id)).toBe(true);
    expect(session.getPendingProposal()).toBeNull();

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages.length).toBe(1);
    expect(draft.stages?.length).toBe(1);
    expect(typeof draft.pipeline.stages[0]!.id).toBe("string");
  });

  it("is distinct from stage-execution AgentPort (no openStage/runStage)", () => {
    const host = createWorkshopOperatorHost();
    expect("openStage" in host).toBe(false);
    expect("runStage" in host).toBe(false);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(),
    });
    expect("openStage" in session).toBe(false);
    expect("runStage" in session).toBe(false);
  });
});

describe("createDraftPackage (first Save)", () => {
  it("creates a new package after validate and refuses when invalid", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });

      const invalid: DraftPackage = {
        pipeline: {
          id: "broken",
          stages: [{ id: "plan", system_prompt: "x", model: MODEL }],
        },
      };
      const refused = await createDraftPackage(root, {
        directory: "pipelines",
        draft: invalid,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.status).toBe(422);

      const valid: DraftPackage = {
        pipeline: {
          id: "workshop-demo",
          stages: [
            {
              id: "clarify",
              uses: "./clarify.yaml",
              entry: true,
            },
          ],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify the task",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };

      const validation = await validateDraftPackage(valid, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(validation.ok).toBe(true);

      const created = await createDraftPackage(root, {
        directory: "pipelines",
        draft: valid,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.pipelinePath).toBe("pipelines/workshop-demo.pipeline.yaml");
      const yaml = await readFile(
        path.join(root, "pipelines", "workshop-demo.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("workshop-demo");
      expect(yaml).toContain("clarify");

      const collision = await createDraftPackage(root, {
        directory: "pipelines",
        draft: valid,
      });
      expect(collision.ok).toBe(false);
      if (collision.ok) return;
      expect(collision.status).toBe(409);
    } finally {
      await cleanup();
    }
  });
});
