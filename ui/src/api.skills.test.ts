import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSkills, fetchSkillUsage, installSkill } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("skills api clients", () => {
  it("GET /api/skills appends project_root when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ skills: [], diagnostics: [] }),
      ),
    );
    await fetchSkills("/tmp/proj");
    expect(fetch).toHaveBeenCalledWith(
      "/api/skills?project_root=%2Ftmp%2Fproj",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("GET /api/skills/usage omits query when project_root is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ usages: {} })),
    );
    await fetchSkillUsage();
    expect(fetch).toHaveBeenCalledWith(
      "/api/skills/usage",
      expect.anything(),
    );
  });

  it("installSkill returns ok payload on 201", async () => {
    const command =
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: true,
            skill_name: "find-skills",
            dest_path: "/tmp/proj/.pi/skills/find-skills",
            project_root: "/tmp/proj",
          },
          { status: 201 },
        ),
      ),
    );
    await expect(installSkill({ command })).resolves.toEqual({
      ok: true,
      skillName: "find-skills",
      destPath: "/tmp/proj/.pi/skills/find-skills",
      message: "Installed find-skills",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/skills/install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ command }),
      }),
    );
  });

  it("installSkill returns error on 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "invalid command" }, { status: 400 }),
      ),
    );
    await expect(
      installSkill({ command: "npx skills add bad" }),
    ).resolves.toEqual({
      ok: false,
      status: 400,
      error: "invalid command",
    });
  });
});
