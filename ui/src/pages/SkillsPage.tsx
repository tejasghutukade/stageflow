import { useCallback, useEffect, useState } from "react";
import { fetchSkills, type SkillListing } from "../api";
import { skillPath } from "../routes";

export function SkillsPage({ skillName }: { skillName?: string }) {
  const [skills, setSkills] = useState<SkillListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchSkills();
      setSkills(result.skills);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = skillName
    ? (skills.find((skill) => skill.name === skillName) ?? null)
    : null;

  if (skillName) {
    return (
      <SkillDetail
        skillName={skillName}
        skill={selected}
        loading={loading}
        error={error}
      />
    );
  }

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Skills</h1>
          <p>
            Skills the Pi SDK can discover on this machine. Factory stages do
            not load them.
          </p>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading skills…</p> : null}
      {!loading && skills.length === 0 ? (
        <p className="muted">
          No skills found under ~/.pi/agent/skills, ~/.agents/skills, or this
          project's .pi/skills / .agents/skills.
        </p>
      ) : null}

      {!loading && skills.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Scope</th>
              <th>Source</th>
              <th>Invocation</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={`${skill.scope}:${skill.filePath}`}>
                <td>
                  <a href={`#${skillPath(skill.name)}`}>{skill.name}</a>
                  <div
                    className="muted"
                    style={{ fontSize: "var(--font-size-xs)" }}
                  >
                    {skill.description}
                  </div>
                </td>
                <td className="mono">{skill.scope}</td>
                <td className="mono">{skill.source}</td>
                <td className="mono">
                  {skill.disableModelInvocation ? "command-only" : "model"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function SkillDetail({
  skillName,
  skill,
  loading,
  error,
}: {
  skillName: string;
  skill: SkillListing | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/skills">Skills</a> / {skillName}
      </p>

      <div className="page-head">
        <div>
          <h1>{skillName}</h1>
          <p className="mono">
            {skill
              ? `${skill.scope} · ${skill.source}`
              : skillName}
          </p>
        </div>
      </div>

      {error ? (
        <p style={{ color: "var(--color-text-red)" }}>{error}</p>
      ) : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && !skill ? (
        <p className="muted">
          {skillName} is not in the Pi skill catalog on this machine.
        </p>
      ) : null}

      {skill ? (
        <>
          <h3>Description</h3>
          <p>{skill.description}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Invocation
          </p>
          <p className="mono">
            {skill.disableModelInvocation ? "command-only" : "model"}
          </p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            File path
          </p>
          <p className="mono">{skill.filePath}</p>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            Base dir
          </p>
          <p className="mono">{skill.baseDir}</p>
        </>
      ) : null}
    </div>
  );
}
