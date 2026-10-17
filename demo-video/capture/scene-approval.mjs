import { record } from "./lib.mjs";
await record("approval", async (p, h) => {
  await h.sleep(1800);
  await h.hover(p.getByText("What will run", { exact: false }).first(), 1800);
  await h.click(p.getByRole("button", { name: /Approve and run/ }), { before: 900, after: 3500 });
}, { startPath: "/#/inbox" });
