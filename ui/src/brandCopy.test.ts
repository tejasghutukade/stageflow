import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function readUi(rel: string): string {
  return readFileSync(path.join(here, rel), "utf8");
}

describe("operator console brand copy", () => {
  it("sets the document title to Stageflow and keeps the sf-theme script key", () => {
    const html = readUi("../index.html");
    expect(html).toMatch(/<title>Stageflow<\/title>/);
    expect(html).toMatch(/localStorage\.getItem\("sf-theme"\)/);
    expect(html).not.toMatch(/software-factory/i);
    expect(html).not.toMatch(/Software Factory/);
  });

  it("shows Stageflow on the app rail", () => {
    const src = readUi("./components/AppRail.tsx");
    expect(src).toMatch(/<span>Stageflow<\/span>/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
  });

  it("names Stageflow in Settings intro copy", () => {
    const src = readUi("./pages/SettingsPage.tsx");
    expect(src).toMatch(/Stageflow runs as one operator's CLI/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
  });

  it("names Stageflow in Settings provider copy and keeps sf_owned", () => {
    const src = readUi("./components/SettingsProviders.tsx");
    expect(src).toMatch(/Stageflow-owned/);
    expect(src).toMatch(/value="sf_owned"/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
  });

  it("names Stageflow on Connect and keeps sf_owned", () => {
    const src = readUi("./pages/ProviderConnectPage.tsx");
    expect(src).toMatch(/Set up in Stageflow/);
    expect(src).toMatch(/inside Stageflow/);
    expect(src).toMatch(/in Stageflow/);
    expect(src).toMatch(/useState<CredentialSource>\("sf_owned"\)/);
    expect(src).toMatch(/postCredentialSource\("sf_owned"\)/);
    expect(src).toMatch(/choice === "sf_owned"/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
  });
});
