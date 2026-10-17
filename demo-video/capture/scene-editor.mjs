import { record } from "./lib.mjs";
await record("editor", async (p, h) => {
  await h.click(p.getByRole("link", { name: /Pipelines/ }).first(), { after: 1500 });
  await h.type(p.getByPlaceholder(/Search pipelines/), "release", 90);
  await h.click(p.getByText("release-notes", { exact: true }).first(), { after: 1200 });
  await h.click(p.getByRole("button", { name: /Open editor/ }), { after: 2500 });
  await h.click(p.getByText("editor-review", { exact: true }).last(), { after: 2200 });
  await h.click(p.getByText("risk-scan", { exact: true }).last(), { after: 2200 });
}, { startPath: "/#/inbox" });
