import { record } from "./lib.mjs";
await record("agents", async (p, h) => {
  await h.click(p.getByRole("link", { name: /^Agents$/ }).first(), { after: 2200 });
  await h.click(p.getByRole("link", { name: "Open Support" }), { after: 2000, position: { x: 60, y: 20 } });
  await h.click(p.getByRole("link", { name: /SSO audit log/ }).first(), { after: 2600, position: { x: 80, y: 20 } });
  await p.goBack(); await h.sleep(1200);
  await h.click(p.getByText("Configuration", { exact: true }), { after: 1500 });
  await h.scroll(p, 700, 1500);
  await h.scroll(p, 700, 1500);
}, { startPath: "/#/inbox" });
