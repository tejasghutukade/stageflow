import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { useHotkeys } from "./keys";
import { StartRunDialog } from "./startRun/StartRunDialog";
import { navigate, type Route } from "../routes";

export type ConsoleOverlaysProps = {
  route: Route;
  redesignOn: boolean;
  workspaceName: string;
  onStarted: (runId: string) => void;
  onOpenPaletteRef?: (open: () => void) => void;
};

export function ConsoleOverlays({
  route,
  redesignOn,
  workspaceName,
  onStarted,
  onOpenPaletteRef,
}: ConsoleOverlaysProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [startRunOpen, setStartRunOpen] = useState(false);
  const focusReturnRef = useRef<HTMLElement | null>(null);

  const rememberFocus = useCallback(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) focusReturnRef.current = el;
  }, []);

  const restoreFocus = useCallback(() => {
    const el = focusReturnRef.current;
    focusReturnRef.current = null;
    if (el?.isConnected) {
      el.focus();
      return;
    }
  }, []);

  const openPalette = useCallback(() => {
    rememberFocus();
    setPaletteOpen(true);
  }, [rememberFocus]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  const openStartRun = useCallback(() => {
    rememberFocus();
    setPaletteOpen(false);
    setStartRunOpen(true);
  }, [rememberFocus]);

  const closeStartRun = useCallback(() => {
    setStartRunOpen(false);
    restoreFocus();
    if (route.name === "new") {
      navigate("/inbox");
    }
  }, [route.name, restoreFocus]);

  useEffect(() => {
    onOpenPaletteRef?.(openPalette);
  }, [onOpenPaletteRef, openPalette]);

  useEffect(() => {
    if (!redesignOn) return;
    if (route.name === "new") {
      rememberFocus();
      setStartRunOpen(true);
    }
  }, [
    redesignOn,
    route.name,
    route.name === "new" ? route.taskPath : undefined,
    route.name === "new" ? route.pipelineId : undefined,
    rememberFocus,
  ]);

  useHotkeys(
    [
      {
        key: "mod+k",
        scope: "global",
        when: () => redesignOn,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          if (paletteOpen) closePalette();
          else openPalette();
        },
      },
      {
        key: "escape",
        scope: "global",
        when: () => redesignOn && startRunOpen,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          closeStartRun();
        },
      },
      {
        key: "escape",
        scope: "global",
        when: () => redesignOn && paletteOpen && !startRunOpen,
        allowInInput: true,
        handler: (e) => {
          e.preventDefault();
          closePalette();
        },
      },
    ],
    "global",
  );

  if (!redesignOn) return null;

  const initialTaskPath = route.name === "new" ? route.taskPath : undefined;
  const initialPipelinePath =
    route.name === "new" ? route.pipelineId : undefined;

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        workspaceName={workspaceName}
        onNavigate={(path) => navigate(path)}
        onOpenStartRun={openStartRun}
      />
      <StartRunDialog
        open={startRunOpen}
        onClose={closeStartRun}
        onStarted={onStarted}
        initialTaskPath={initialTaskPath}
        initialPipelinePath={initialPipelinePath}
      />
    </>
  );
}
