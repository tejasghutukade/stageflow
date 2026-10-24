import { afterEach, describe, expect, it } from "vitest";
import { parseHash } from "../../../routes";
import {
  closeRunDialog,
  currentRunDialogTarget,
  openRunDialog,
  openRunTargetFromRoute,
  pathWithoutOpenRun,
} from "./runDialogStore";

afterEach(() => closeRunDialog());

describe("openRun flag", () => {
  it("reads the flag from eval routes only", () => {
    expect(openRunTargetFromRoute(parseHash("#/evals/critique-sample?openRun=1"))).toEqual({ evalId: "critique-sample" });
    expect(openRunTargetFromRoute(parseHash("#/evals/e/edit?openRun=1"))).toEqual({ evalId: "e" });
    expect(openRunTargetFromRoute(parseHash("#/evals/e/runs/3?openRun=1"))).toEqual({ evalId: "e" });
    expect(openRunTargetFromRoute(parseHash("#/evals/e"))).toBeNull();
    expect(openRunTargetFromRoute(parseHash("#/evals?openRun=1"))).toBeNull();
  });

  it("strips the flag and keeps the rest", () => {
    expect(pathWithoutOpenRun(parseHash("#/evals/e?openRun=1"))).toBe("/evals/e");
    expect(pathWithoutOpenRun(parseHash("#/evals/e/edit?openRun=1"))).toBe("/evals/e/edit");
    expect(pathWithoutOpenRun(parseHash("#/evals/e/runs/3?tab=config&openRun=1"))).toBe("/evals/e/runs/3?tab=config");
    expect(pathWithoutOpenRun(parseHash("#/evals"))).toBeNull();
  });
});

describe("openRunDialog", () => {
  it("stores and clears the target", () => {
    expect(currentRunDialogTarget()).toBeNull();
    openRunDialog("e", "/root");
    expect(currentRunDialogTarget()).toEqual({ evalId: "e", projectRoot: "/root" });
    openRunDialog("f");
    expect(currentRunDialogTarget()).toEqual({ evalId: "f" });
    closeRunDialog();
    expect(currentRunDialogTarget()).toBeNull();
  });
});
