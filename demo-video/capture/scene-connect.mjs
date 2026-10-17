import { record } from "./lib.mjs";
await record("connect", async (p, h) => {
  await h.click(p.getByRole("link", { name: /Connections/ }).first(), { after: 1800 });
  await h.click(p.getByRole("button", { name: "Connect" }).nth(1), { after: 1600 });
  await h.click(p.getByText("Telegram", { exact: true }).last(), { after: 1400 });
  await h.click(p.getByRole("dialog").getByText(/^iMessage/).first(), { after: 1400 });
  await p.keyboard.press("Escape"); await h.sleep(800);
  await h.click(p.getByRole("link", { name: /Settings|demo/ }).first(), { after: 1800 }).catch(() => {});
}, { startPath: "/#/inbox" });
