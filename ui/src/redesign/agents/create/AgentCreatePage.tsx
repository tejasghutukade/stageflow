import { useEffect, useRef, useState } from "react";
import { LuCheck, LuCircle, LuCode, LuTriangleAlert } from "react-icons/lu";
import { AgentApiError, agentsApi, createAuthorSession, getAuthorSession, saveAuthorDraft, type AgentDefinition, type AgentIssue } from "../../../api/agents";
import { agentCreatePath, agentPath, agentsPath, navigate } from "../../../routes";
import { NOWRAP, PAGE_BG } from "../agentsTokens";
import { AgentDefinitionForm, CREATE_SECTIONS } from "../config/AgentDefinitionForm";
import { YamlDialog } from "../editor/Dialogs";
import { useSectionSpy } from "../editor/useSectionSpy";
import { completeDefinition, newAgentDefinition } from "../model/definition";
import { useDefinitionValidation, useEditorOptions } from "../model/hooks";
import { markAgentCreated } from "../useAgent";
import { Button, PageFooter } from "../ui"
import { PageHeader } from "../../shell/PageHeader";;
import { AgentAuthorChatColumn, authorMessagesFromTranscript } from "./AgentAuthorChatColumn";

export function AgentCreatePage({ authorSessionId }: { authorSessionId?: string }) {
  const openedWith = useRef(authorSessionId);
  const sessionRef = useRef<string | undefined>(authorSessionId);
  const [sessionId, setSessionId] = useState<string | undefined>(authorSessionId);
  const [definition, setDefinition] = useState<AgentDefinition>(newAgentDefinition);
  const [authorWroteInstructions, setAuthorWroteInstructions] = useState(false);
  const [boot, setBoot] = useState<"loading" | "ready">(authorSessionId ? "loading" : "ready");
  const [seedMessages, setSeedMessages] = useState<ReturnType<typeof authorMessagesFromTranscript> | undefined>(undefined);
  const [seedModel, setSeedModel] = useState<string | undefined>(undefined);
  const skipSave = useRef(Boolean(authorSessionId));
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<AgentIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const options = useEditorOptions();
  const validation = useDefinitionValidation(definition);
  const spy = useSectionSpy(CREATE_SECTIONS);

  useEffect(() => {
    const id = openedWith.current;
    if (!id) return;
    let cancelled = false;
    void getAuthorSession(id)
      .then((record) => {
        if (cancelled) return;
        const next = completeDefinition(record.draft);
        setDefinition(next);
        setAuthorWroteInstructions(Boolean(next.instructions.trim()));
        setSeedMessages(authorMessagesFromTranscript(record.transcript));
        if (record.model) setSeedModel(record.model);
        setSessionId(record.id);
        sessionRef.current = record.id;
        setBoot("ready");
      })
      .catch(() => {
        if (cancelled) return;
        sessionRef.current = undefined;
        setSessionId(undefined);
        navigate(agentCreatePath());
        setBoot("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const id = sessionRef.current;
    if (!id) return;
    const draft = definition;
    const timer = setTimeout(() => {
      void saveAuthorDraft(id, draft).catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(timer);
      void saveAuthorDraft(id, draft).catch(() => undefined);
    };
  }, [definition, boot]);

  async function ensureSession(draft: AgentDefinition): Promise<string> {
    if (sessionRef.current) return sessionRef.current;
    const created = await createAuthorSession(draft);
    sessionRef.current = created.id;
    setSessionId(created.id);
    navigate(agentCreatePath({ session: created.id }));
    return created.id;
  }

  function rememberSession(id: string) {
    if (sessionRef.current === id) return;
    sessionRef.current = id;
    setSessionId(id);
    navigate(agentCreatePath({ session: id }));
  }

  const allIssues = validation.pending && saveIssues.length > 0 ? saveIssues : validation.issues;
  // Empty required fields aren't errors until the operator tries to save.
  const issues = attempted ? allIssues : allIssues.filter((issue) => issue.code !== "agent.required");
  const onlyMissing = validation.issues.length > 0 && validation.issues.every((issue) => issue.code === "agent.required");
  const ready = !validation.pending && validation.issues.length === 0;

  function onFormChange(next: AgentDefinition) {
    setSaveIssues([]);
    setSaveError(null);
    if (next.instructions !== definition.instructions) setAuthorWroteInstructions(false);
    setDefinition(next);
    void ensureSession(next);
  }

  function onAuthorChange(next: AgentDefinition) {
    if (next.instructions !== definition.instructions) setAuthorWroteInstructions(true);
    setDefinition(next);
  }

  async function onSave() {
    setAttempted(true);
    if (saving || !ready) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await agentsApi.create(definition);
      markAgentCreated(created.agent.id);
      navigate(agentPath(created.agent.id));
    } catch (error) {
      if (error instanceof AgentApiError && error.issues.length > 0) setSaveIssues(error.issues);
      setSaveError(
        error instanceof AgentApiError
          ? error.message
          : "Could not save the agent.",
      );
    } finally {
      setSaving(false);
    }
  }

  const status = validation.pending
    ? { tone: "muted" as const, label: "Checking…" }
    : onlyMissing && !attempted
      ? { tone: "muted" as const, label: "Name and instructions are required" }
      : validation.issues.length > 0
        ? { tone: "fail" as const, label: `${validation.issues.length} to fix before saving` }
        : validation.warnings.length > 0
          ? { tone: "needs" as const, label: `Can save · ${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"}` }
          : { tone: "ok" as const, label: "Ready to save" };
  const statusColor = {
    muted: "text-[var(--sf-text-3)]",
    fail: "text-[var(--sf-fail)]",
    needs: "text-[var(--sf-needs)]",
    ok: "text-[var(--sf-ok)]",
  }[status.tone];

  return (
    <div className={PAGE_BG}>
      <PageHeader
        crumbs={[{ label: "Agents", onClick: () => navigate(agentsPath()) }, { label: "New agent" }]}
        title={definition.name.trim() || "New agent"}
        titleAddon={
          <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-[var(--sf-raised)] px-2">
            <LuCircle aria-hidden className="size-2.5 text-[var(--sf-text-3)]" />
            <span className={`text-xs leading-[1.33333] text-[var(--sf-text-2)] ${NOWRAP}`}>Draft · not saved</span>
          </span>
        }
        description="Describe the agent in chat, or edit the config directly. It saves disabled, so nothing runs until you enable it."
        actions={
          <>
            <Button variant="ghost" icon={<LuCode aria-hidden />} onClick={() => setYamlOpen(true)}>
              View YAML
            </Button>
            <Button onClick={() => navigate(agentsPath())}>Discard</Button>
            <Button variant="primary" disabled={saving || validation.pending} onClick={() => void onSave()}>
              {saving ? "Saving…" : "Save agent"}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-[420px] w-full min-w-0 flex-col border-b border-b-[var(--sf-hairline)] lg:w-[400px] lg:shrink-0 lg:border-b-0 lg:border-r lg:border-r-[var(--sf-hairline)]">
          {boot === "loading" ? (
            <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">Loading draft…</p>
          ) : (
            <AgentAuthorChatColumn
              definition={definition}
              onDefinitionChange={onAuthorChange}
              sessionId={sessionId}
              initialMessages={seedMessages}
              initialModel={seedModel}
              onSessionId={rememberSession}
            />
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-b-[var(--sf-hairline)] px-7">
            <nav className="flex items-center gap-4 overflow-x-auto" aria-label="Config sections">
              {CREATE_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => spy.jump(section.id)}
                  className={`text-xs leading-[1.33333] ${NOWRAP} ${
                    spy.active === section.id ? "font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
                  }`}
                >
                  {section.label}
                </button>
              ))}
            </nav>
            <span className={`flex shrink-0 items-center gap-1.5 text-xs leading-[1.33333] ${NOWRAP} ${statusColor}`} role="status">
              {status.tone === "ok" ? <LuCheck aria-hidden className="size-3" /> : status.tone !== "muted" ? <LuTriangleAlert aria-hidden className="size-3" /> : null}
              {status.label}
            </span>
          </div>
          {saveError ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-b-[#f2645a33] bg-[var(--sf-fail-bg)] px-7 py-2 text-xs text-[var(--sf-fail)]" role="alert">
              <LuTriangleAlert aria-hidden className="size-3" />
              {saveError}
            </div>
          ) : null}
          <div ref={spy.scrollRef} onScroll={spy.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <AgentDefinitionForm
              mode="create"
              definition={definition}
              onChange={onFormChange}
              issues={issues}
              warnings={validation.warnings}
              options={options}
              authorWroteInstructions={authorWroteInstructions}
            />
          </div>
        </div>
      </div>

      <PageFooter
        left="Saves to agents/….agent.yaml · disabled until you enable it"
        right="Saving doesn't start a run"
      />

      {yamlOpen ? <YamlDialog title="Draft YAML" yaml={validation.yaml} onClose={() => setYamlOpen(false)} /> : null}
    </div>
  );
}
