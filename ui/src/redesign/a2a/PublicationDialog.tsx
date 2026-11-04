import { useState } from "react";
import { A2aApiError, a2aApi, type A2aCaller, type A2aContract, type A2aPublication } from "../../api/a2a";
import { IdentityDialog } from "../identity/identityOverlay";
import { Field, GHOST, INPUT, MONO, PRIMARY, SECONDARY } from "../identity/identityParts";
import { A2aError } from "./A2aParts";
import { INPUT_FROM_ENTRY_STAGE, publicationDirty, toggleCaller } from "./a2aView";

export function ContractPreview({ contract }: { contract: A2aContract }) {
  return (
    <div className="flex flex-col gap-3" data-testid="a2a-contract">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[#8b8f98]">What the other agent sends</span>
        <pre className={`max-h-56 overflow-auto rounded-md border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs text-[#ecedee] ${MONO}`}>{JSON.stringify(contract.inputSchema, null, 2)}</pre>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[#8b8f98]">What it gets back</span>
        <pre className={`max-h-56 overflow-auto rounded-md border border-[#ffffff12] bg-[#0c0d0f] p-3 text-xs text-[#ecedee] ${MONO}`}>{JSON.stringify(contract.outputSchema, null, 2)}</pre>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[#8b8f98]">Files it can download</span>
        <span className={`text-[13px] text-[#ecedee] ${MONO}`}>{contract.artifacts.length > 0 ? contract.artifacts.join(", ") : "None"}</span>
      </div>
    </div>
  );
}

export function PublicationDialog({
  publication,
  callers,
  onClose,
  onSaved,
}: {
  publication: A2aPublication;
  callers: readonly A2aCaller[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(publication.description);
  const [allowed, setAllowed] = useState<string[]>(publication.allowedCallers);
  const [contract, setContract] = useState<A2aContract | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const dirty = publicationDirty(publication, description, allowed);
  const draft: A2aPublication = { ...publication, description, allowedCallers: allowed };

  async function run(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(err instanceof A2aApiError ? { code: err.code, detail: err.detail } : { code: "request_failed", detail: "" });
    }
    setBusy(false);
  }

  return (
    <IdentityDialog
      title={publication.name}
      subtitle={publication.id}
      titleId="a2a-publication-title"
      busy={busy}
      onClose={onClose}
      onSubmit={() => void run(async () => {
        await a2aApi.updatePublication(publication.id, { description, allowedCallers: allowed });
        onSaved();
      })}
      footer={
        <>
          <span className="text-xs text-[#8b8f98]">Applies to new calls. Tasks already running keep their settings.</span>
          <div className="flex items-center gap-2">
            <button type="button" className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </>
      }
    >
      <dl className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-[#8b8f98]">Pipeline</dt>
          <dd className={`min-w-0 break-words text-right text-[13px] text-[#ecedee] ${MONO}`}>{publication.pipeline}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-xs text-[#8b8f98]">Input schema</dt>
          <dd className={`min-w-0 break-words text-right text-[13px] text-[#ecedee] ${MONO}`}>{publication.inputSchema || INPUT_FROM_ENTRY_STAGE}</dd>
        </div>
      </dl>
      <Field label="Description" hint="What other agents read to decide whether to call this pipeline.">
        <textarea
          className={`${INPUT} h-24 resize-y py-2`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-[#ecedee]">Callers that may use it</span>
        {callers.length === 0 ? (
          <span className="text-xs text-[#8b8f98]">Add a caller first.</span>
        ) : (
          callers.map((caller) => (
            <label key={caller.id} className="flex items-center gap-2 text-[13px] text-[#ecedee]">
              <input
                type="checkbox"
                checked={allowed.includes(caller.id)}
                onChange={(event) => setAllowed(toggleCaller(allowed, caller.id, event.target.checked))}
              />
              <span className={MONO}>{caller.id}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-[#ecedee]">What the other agent will see</span>
          <button
            type="button"
            className={SECONDARY}
            disabled={busy}
            onClick={() => void run(async () => setContract(await a2aApi.previewPublication(draft)))}
          >
            {contract ? "Refresh preview" : "Preview contract"}
          </button>
        </div>
        {contract ? <ContractPreview contract={contract} /> : null}
      </div>
      {error ? <A2aError code={error.code} detail={error.detail} /> : null}
    </IdentityDialog>
  );
}
