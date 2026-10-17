import { record, api } from "./lib.mjs";
const rid = (await api("/api/runs")).runs.find((r) => r.pipeline_id === "vendor-research").run_id;
await record("inspect", async (p, h) => {
  await h.click(p.getByRole("link", { name: /Pipeline runs/ }).first(), { after: 1500 });
  await h.click(p.getByText("vendor-evaluation", { exact: true }).first(), { after: 2200 });
  await h.click(p.getByText("Graph", { exact: true }), { after: 1500 });
  await h.click(p.getByText("research-p", { exact: false }).first(), { after: 1800 });
  await h.click(p.getByText(/^Events/).first(), { after: 1800 });
  await h.click(p.getByText("Envelope", { exact: true }).first(), { after: 2200 });
  await h.click(p.getByText(/^Artifacts/).first(), { after: 2200 });
  await h.click(p.getByText("pricing.md").first(), { after: 2500 });
}, { startPath: "/#/inbox" });
