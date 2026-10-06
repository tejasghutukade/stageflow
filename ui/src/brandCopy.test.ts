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

  it("names Stageflow in Settings provider copy", () => {
    const src = readUi("./components/SettingsProviders.tsx");
    expect(src).toMatch(/PROVIDERS_PI_COPY/);
    expect(readUi("./providers/helpers.ts")).toMatch(/Stageflow/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
    expect(src).not.toMatch(/value="pi_home"/);
  });

  it("names Stageflow on Connect and persists sf_owned", () => {
    const src = readUi("./pages/ProviderConnectPage.tsx");
    expect(src).toMatch(/postCredentialSource\("sf_owned"\)/);
    expect(src).not.toMatch(/software-factory/);
    expect(src).not.toMatch(/Software Factory/);
    expect(src).not.toMatch(/pi_home/);
  });
});
