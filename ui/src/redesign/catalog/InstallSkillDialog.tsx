import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";
import { installSkill, runSkillDoctor } from "../../api";
import { showToast } from "../../toast";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const EXAMPLE =
  "npx skills add https://github.com/vercel-labs/skills --skill find-skills";
const TEXTAREA =
  `min-h-[88px] w-full resize-y rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2 text-xs leading-[1.55] text-[#ecedee] outline-none placeholder:text-[#8b8f98] focus:border-[#ecedee73] ${MONO}`;

type DoctorPending = {
  command: string;
  skillName: string;
  doctorScript: string;
};

export type InstallSkillDialogProps = {
  open: boolean;
  onClose: () => void;
  onInstalled?: () => void;
};

export function InstallSkillDialog({
  open,
  onClose,
  onInstalled,
}: InstallSkillDialogProps) {
  const [command, setCommand] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [doctorPending, setDoctorPending] = useState<DoctorPending | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    setCommand("");
    setSubmitting(false);
    setDoctorPending(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit() {
    const trimmed = command.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    const result = await installSkill({ command: trimmed });
    setSubmitting(false);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    if (result.doctorAvailable && result.doctorScript) {
      setDoctorPending({
        command: trimmed,
        skillName: result.skillName,
        doctorScript: result.doctorScript,
      });
      return;
    }
    showToast(result.message || `Installed ${result.skillName}`);
    onClose();
    onInstalled?.();
  }

  async function confirmDoctor() {
    if (!doctorPending || submitting) return;
    setSubmitting(true);
    // Run the script that was just installed and shown; reinstalling would fetch a possibly different one.
    const result = await runSkillDoctor(doctorPending.skillName);
    setSubmitting(false);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    showToast(`Ran ${doctorPending.doctorScript} for ${doctorPending.skillName}`);
    setDoctorPending(null);
    onClose();
    onInstalled?.();
  }

  function skipDoctor() {
    if (!doctorPending) return;
    showToast(`Installed ${doctorPending.skillName}`);
    setDoctorPending(null);
    onClose();
    onInstalled?.();
  }

  const doctorStep = doctorPending !== null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#040506a8] p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[520px] flex-col rounded-xl border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-skill-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-full items-start gap-3 px-5 pb-2.5 pt-3.5">
          <div className="flex flex-1 flex-col gap-[3px]">
            <h2
              id="install-skill-title"
              className="text-lg font-semibold tracking-[-0.36px] text-[#ecedee]"
            >
              {doctorStep ? "Run skill doctor" : "Install skill"}
            </h2>
            <p className="text-[13px] text-[#a7aab2]">
              {doctorStep ? (
                <>
                  Installed{" "}
                  <span className="text-[#ecedee]">{doctorPending.skillName}</span>
                  . Run{" "}
                  <span className={`break-all text-[#ecedee] ${MONO} text-xs`}>
                    {doctorPending.doctorScript}
                  </span>{" "}
                  to verify the skill?
                </>
              ) : (
                <>
                  Paste an install command, for example{" "}
                  <span className={`break-all text-[#ecedee] ${MONO} text-xs`}>
                    {EXAMPLE}
                  </span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-[#8b8f98] hover:bg-[#1a1c21]"
          >
            <LuX className="size-4" aria-hidden />
          </button>
        </div>
        {!doctorStep ? (
          <div className="flex flex-col gap-3.5 px-5 py-3">
            <label className="flex flex-col gap-[5px]">
              <span className="font-sans text-xs leading-normal text-[#a7aab2]">
                Command
              </span>
              <textarea
                className={TEXTAREA}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={EXAMPLE}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 border-t border-t-[#ffffff12] px-5 py-3">
          {doctorStep ? (
            <>
              <button
                type="button"
                onClick={skipDoctor}
                disabled={submitting}
                className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] disabled:opacity-50"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void confirmDoctor()}
                className="flex h-8 items-center rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-50"
              >
                {submitting ? "Running…" : "Run doctor"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting || !command.trim()}
                onClick={() => void submit()}
                className="flex h-8 items-center rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f] disabled:opacity-50"
              >
                {submitting ? "Installing…" : "Install"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
