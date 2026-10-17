import { record, api, sleep } from "./lib.mjs";
const gateOpen = async () => { for (let i = 0; i < 90; i++) { const r = (await api("/api/runs")).runs.find((x) => x.pipeline_id === "release-notes" && x.waiting_stage_id); if (r) return; await sleep(1000); } };
await record("liverun", async (p, h) => {
  // 1. Start a run from the console
  await h.click(p.getByRole("button", { name: /Start a run/ }).first(), { after: 900 });
  await h.click(p.getByText("release-v2-4", { exact: true }), { after: 700 });
  await h.click(p.getByText("release-notes", { exact: true }).first(), { after: 900 });
  await h.click(p.getByRole("button", { name: /^Start run/ }), { before: 800, after: 1500 });
  // 2. Watch the run live
  // 3. Gate arrives: open the Inbox
  await gateOpen();
  await h.sleep(2500);
  await h.click(p.getByRole("link", { name: /Inbox/ }).first(), { before: 600, after: 1800 });
  await h.click(p.getByText("tasks/release-v2-4.task.yaml").first(), { before: 500, after: 1200 });
  await h.hover(p.getByText("release-notes.md").first(), 1200);
  await h.type(p.getByPlaceholder(/Add a note/), "Looks good. Ship it.", 55);
  await h.click(p.getByRole("button", { name: /Accept/ }), { before: 900, after: 1500 });
  // 4. Back on the run: publish finishes
  await h.click(p.getByRole("link", { name: /Pipeline runs/ }).first(), { before: 700, after: 1200 });
  await h.sleep(7000);
}, { startPath: "/#/runs", viewport: { width: 1920, height: 1080 } });
