import { useCallback, useEffect, useMemo, useState } from "react";
import { LuCheck, LuCircleSlash, LuCode, LuPlay, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import { AgentApiError, agentsApi, type AgentDefinition, type AgentDetail, type AgentRevisionMeta, type DiffLine } from "../../../api/agents";
import { agentPath, agentsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { MONO, NOWRAP, PAGE_BG } from "../agentsTokens";
import { AgentDefinitionForm, EDIT_SECTIONS } from "../config/AgentDefinitionForm";
import { AgentLoadError } from "../AgentLoadState";
import { DiffDialog, diffText, YamlDialog } from "../editor/Dialogs";
import { useSectionSpy } from "../editor/useSectionSpy";
import { changedFields, changedSections, webChatLink } from "../model/definition";
import { useAgentDetail, useDefinitionValidation, useEditorOptions } from "../model/hooks";
import { Button, ChangedDot, PageFooter, PageHeader } from "../ui";

type Compare = { revision: number; lines: DiffLine[] | null };

function summaryFor(labels: string[]): string {
  if (labels.length === 0) return "";
  const text = labels.join(", ");
  return `Changed ${text}`.slice(0, 200);
}

function EditView({ initial, onReload }: { initial: AgentDetail & { definition: AgentDefinition }; onReload: () => Promise<void> }) {
  const [detail, setDetail] = useState(initial);
  const saved = detail.definition;
  const [draft, setDraft] = useState<AgentDefinition>(saved);
  const [revisions, setRevisions] = useState<AgentRevisionMeta[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const options = useEditorOptions();
  const validation = useDefinitionValidation(draft);
  const spy = useSectionSpy(EDIT_SECTIONS);
  const agent = detail.agent;

  const labels = useMemo(() => changedFields(saved, draft), [saved, draft]);
  const sections = useMemo(() => changedSections(saved, draft), [saved, draft]);
  const dirty = labels.length > 0;
  const canSave = dirty && !validation.pending && validation.issues.length === 0 && !saving;

  const loadRevisions = useCallback(() => {
    agentsApi.revisions(agent.id).then(setRevisions, () => setRevisions([]));
  }, [agent.id]);
  useEffect(loadRevisions, [loadRevisions, agent.revision]);

  const adopt = useCallback((next: AgentDetail) => {
    if (!next.definition) return;
    setDetail({ ...next, definition: next.definition });
    setDraft(next.definition);
    setConflict(false);
    setError(null);
  }, []);

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const next = await agentsApi.save(agent.id, { baseRevision: agent.revision, definition: draft, summary: summaryFor(labels) });
      adopt(next);
      showToast(`Saved as v${next.agent.revision}`);
    } catch (err) {
      if (err instanceof AgentApiError && err.code === "agent.conflict") setConflict(true);
      else setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [adopt, agent.id, agent.revision, canSave, draft, labels]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, onSave]);

  async function onToggle() {
    try {
      const next = await agentsApi.setEnabled(agent.id, !agent.enabled);
      // Enabling is a revision of its own; keep unsaved edits on top of it.
      setDetail(next.definition ? { ...next, definition: next.definition } : detail);
      if (next.definition) {
        setDraft((current) => ({ ...current, enabled: next.definition!.enabled }));
      }
      showToast(next.agent.enabled ? "Enabled" : "Disabled");
    } catch (err) {
      showToast(err instanceof AgentApiError ? err.message : "Could not change the agent");
    }
  }

  async function onDelete() {
    try {
      await agentsApi.archive(agent.id);
      navigate(agentsPath());
    } catch (err) {
      showToast(err instanceof AgentApiError ? err.message : "Could not delete the agent");
    }
  }

  function openCompare(revision: number) {
    setCompare({ revision, lines: null });
    agentsApi.diff(agent.id, revision, agent.revision).then(
      (lines) => setCompare({ revision, lines }),
      () => setCompare({ revision, lines: [] }),
    );
  }

  async function onRestore(revision: number) {
    try {
      const next = await agentsApi.restore(agent.id, revision, agent.revision);
      adopt(next);
      setCompare(null);
      showToast(`Restored v${revision} as v${next.agent.revision}`);
    } catch (err) {
      if (err instanceof AgentApiError && err.code === "agent.conflict") setConflict(true);
      else showToast(err instanceof AgentApiError ? err.message : "Could not restore");
    }
  }

  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[
          { label: "Agents", onClick: () => navigate(agentsPath()) },
          { label: saved.name, onClick: () => navigate(agentPath(agent.id)) },
          { label: "Edit" },
        ]}
        title={saved.name}
        titleExtras={
          <>
            {agent.enabled ? (
              <span className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-[#4cc38a1a] px-2">
                <LuCheck aria-hidden className="size-3 text-[var(--sf-ok)]" />
                <span className={`text-xs leading-[1.33333] text-[var(--sf-ok)] ${NOWRAP}`}>Enabled</span>
              </span>
            ) : (
              <span className={`flex h-6 shrink-0 items-center rounded-md bg-[var(--sf-raised)] px-2 text-xs leading-[1.33333] text-[var(--sf-text-2)] ${NOWRAP}`}>
                ○ Disabled
              </span>
            )}
            <span className={`${MONO} shrink-0 rounded-md bg-[var(--sf-raised)] px-2 py-0.5 text-xs leading-[1.33333] text-[var(--sf-text-2)]`}>
              v{agent.revision}
            </span>
          </>
        }
        description={
          agent.stats.active > 0
            ? `Changes apply to new sessions. ${agent.stats.active} open session${agent.stats.active === 1 ? " keeps" : "s keep"} v${agent.revision} until ${agent.stats.active === 1 ? "it finishes" : "they finish"}.`
            : "Changes apply to new sessions. Open sessions keep the version they started on."
        }
        actions={
          <>
            <Button variant="ghost" icon={<LuCode aria-hidden />} onClick={() => setYamlOpen(true)}>
              View YAML
            </Button>
            <Button disabled={!dirty} onClick={() => setDraft(saved)}>
              Discard changes
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void onSave()}>
              {saving ? "Saving…" : `Save as v${agent.revision + 1}`}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[220px] shrink-0 flex-col justify-between border-r border-r-[var(--sf-hairline)] px-3 py-4 md:flex">
          <nav className="flex flex-col gap-0.5" aria-label="Config sections">
            {EDIT_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => spy.jump(section.id)}
                className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] leading-normal ${
                  spy.active === section.id ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
                }`}
              >
                {section.label}
                {sections.has(section.id) ? <ChangedDot /> : null}
              </button>
            ))}
          </nav>
          <div className="flex flex-col gap-1 border-t border-t-[var(--sf-hairline)] pt-3">
            <button
              type="button"
              onClick={() => void onToggle()}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] leading-normal text-[var(--sf-text-2)] hover:bg-[var(--sf-raised)]"
            >
              {agent.enabled ? <LuCircleSlash aria-hidden className="size-3.5" /> : <LuPlay aria-hidden className="size-3.5" />}
              {agent.enabled ? "Disable agent" : "Enable agent"}
            </button>
            {confirmDelete ? (
              <div className="flex flex-col gap-1.5 rounded-md bg-[var(--sf-fail-bg)] px-2.5 py-2">
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-1)]">Remove agents/{agent.id}.agent.yaml? History stays readable.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void onDelete()} className="text-xs font-medium text-[var(--sf-fail)]">
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-[var(--sf-text-2)]">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] leading-normal text-[var(--sf-fail)] hover:bg-[var(--sf-fail-bg)]"
              >
                <LuTrash2 aria-hidden className="size-3.5" />
                Delete agent
              </button>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={`flex h-11 shrink-0 items-center justify-between gap-4 border-b border-b-[var(--sf-hairline)] px-7 ${
              conflict ? "bg-[var(--sf-fail-bg)]" : dirty ? "bg-[#6ca6ff0a]" : ""
            }`}
          >
            {conflict ? (
              <span className="flex items-center gap-2 text-xs leading-[1.33333] text-[var(--sf-fail)]" role="alert">
                <LuTriangleAlert aria-hidden className="size-3" />
                This agent changed since you opened it. Reload to see the latest version; your unsaved edits will be dropped.
                <button type="button" onClick={() => void onReload()} className="font-medium underline">
                  Reload
                </button>
              </span>
            ) : dirty ? (
              <div className="flex min-w-0 items-center gap-2">
                <ChangedDot />
                <span className={`text-xs font-medium leading-[1.33333] text-[var(--sf-text-1)] ${NOWRAP}`}>
                  {labels.length} unsaved change{labels.length === 1 ? "" : "s"}
                </span>
                <span className="truncate text-xs leading-[1.33333] text-[var(--sf-text-2)]">
                  {labels.map((label, index) => (index === 0 ? label[0]!.toUpperCase() + label.slice(1) : label)).join(" · ")}
                </span>
                <button type="button" onClick={() => setDiffOpen(true)} className={`text-xs leading-[1.33333] text-[var(--sf-running)] ${NOWRAP}`}>
                  Review diff
                </button>
              </div>
            ) : (
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">No unsaved changes</span>
            )}
            {conflict ? null : error ? (
              <span className={`flex items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-fail)] ${NOWRAP}`}>
                <LuTriangleAlert aria-hidden className="size-3" />
                {error}
              </span>
            ) : dirty && !validation.pending ? (
              validation.issues.length > 0 ? (
                <span className={`flex items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-fail)] ${NOWRAP}`}>
                  <LuTriangleAlert aria-hidden className="size-3" />
                  {validation.issues.length} to fix before saving
                </span>
              ) : (
                <span className={`flex items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-ok)] ${NOWRAP}`}>
                  <LuCheck aria-hidden className="size-3" />
                  Valid, ready to save
                  {validation.warnings.length > 0 ? ` · ${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"}` : ""}
                </span>
              )
            ) : null}
          </div>
          <div ref={spy.scrollRef} onScroll={spy.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <AgentDefinitionForm
              mode="edit"
              definition={draft}
              onChange={setDraft}
              saved={saved}
              issues={validation.issues}
              warnings={validation.warnings}
              options={options}
              revision={agent.revision}
              webChatUrl={webChatLink(agent)}
              onOpenAgent={(id) => navigate(agentPath(id))}
              versions={{ revisions, current: agent.revision, onCompare: openCompare, onRestore: (revision) => openCompare(revision) }}
            />
          </div>
        </div>
      </div>

      <PageFooter left={`agents/${agent.id}.agent.yaml · v${agent.revision} saved`} right="Saving doesn't interrupt running sessions" />

      {yamlOpen ? <YamlDialog title={dirty ? "YAML after save" : "Saved YAML"} yaml={validation.yaml} onClose={() => setYamlOpen(false)} /> : null}
      {diffOpen ? (
        <DiffDialog
          title={`Unsaved changes against v${agent.revision}`}
          lines={validation.yaml && detail.yaml ? diffText(detail.yaml, validation.yaml) : null}
          onClose={() => setDiffOpen(false)}
        />
      ) : null}
      {compare ? (
        <DiffDialog
          title={`v${compare.revision} → v${agent.revision} (current)`}
          lines={compare.lines}
          onClose={() => setCompare(null)}
          footer={
            <>
              {dirty ? <span className="mr-auto self-center text-xs text-[var(--sf-needs)]">Restoring discards your unsaved changes.</span> : null}
              <Button variant="primary" onClick={() => void onRestore(compare.revision)}>
                Restore v{compare.revision} as v{agent.revision + 1}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

export function AgentEditPage({ agentId }: { agentId: string }) {
  const { detail, loading, error, reload } = useAgentDetail(agentId);
  if (!detail) return <AgentLoadError loading={loading} error={error} />;
  if (!detail.definition) return <AgentLoadError loading={false} error={null} invalid={detail} />;
  return <EditView key={`${detail.agent.id}:${detail.agent.revision}`} initial={{ ...detail, definition: detail.definition }} onReload={reload} />;
}
