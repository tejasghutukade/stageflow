import { record } from "./lib.mjs";
await record("webchat", async (p, h) => {
  const box = p.getByPlaceholder(/Write a message/);
  await h.sleep(1500);
  await h.type(box, "Does v2.4 have an SSO audit log?");
  await p.keyboard.press("Enter");
  await h.sleep(6000);
  await h.type(box, "And when does the v1 export API go away?");
  await p.keyboard.press("Enter");
  await h.sleep(6500);
}, { startPath: "/chat/k7x9m2qp4h8d3w6n" });
