import { createServer, type Socket } from "node:net";

export async function mailServer(protocol: "imap" | "smtp", options: { rejectAuth?: boolean; stall?: boolean; password?: string; rejectRecipient?: string; dropAfterData?: boolean; stallAfterData?: boolean } = {}) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const messages: { data: string; recipients: string[] }[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (options.stall) return;
    socket.write(protocol === "imap" ? "* OK fixture ready\r\n" : "220 fixture ready\r\n");
    let pending = "";
    let authTag: string | undefined;
    let inData = false;
    let messageData = "";
    let recipients: string[] = [];
    function validAuth(encoded: string): boolean {
      return !options.rejectAuth && Buffer.from(encoded, "base64").toString().split("\0").at(-1) === (options.password ?? "fixture-secret");
    }
    socket.on("data", data => {
      pending += data.toString();
      while (pending.includes("\r\n")) {
        const index = pending.indexOf("\r\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        if (protocol === "smtp") {
          if (inData) {
            if (line !== ".") { messageData += `${line.replace(/^\.\./, ".")}\r\n`; continue; }
            inData = false;
            messages.push({ data: messageData, recipients: [...recipients] });
            if (options.dropAfterData) socket.destroy();
            else if (!options.stallAfterData) socket.write("250 Message accepted\r\n");
            continue;
          }
          const command = line.split(" ")[0].toUpperCase();
          commands.push(command);
          if (command === "EHLO") socket.write("250-fixture\r\n250 AUTH PLAIN\r\n");
          else if (command === "AUTH") socket.write(validAuth(line.split(" ")[2] ?? "") ? "235 Authenticated\r\n" : "535 Authentication failed\r\n");
          else if (command === "QUIT") socket.end("221 Bye\r\n");
          else if (command === "MAIL") { recipients = []; messageData = ""; socket.write("250 Sender accepted\r\n"); }
          else if (command === "RCPT") {
            const recipient = line.match(/<([^>]+)>/)?.[1] ?? "";
            if (recipient === options.rejectRecipient) socket.write("550 Recipient rejected\r\n");
            else { recipients.push(recipient); socket.write("250 Recipient accepted\r\n"); }
          }
          else if (command === "DATA") { inData = true; socket.write("354 Send data\r\n"); }
          else socket.write("250 OK\r\n");
        } else {
          if (authTag) {
            socket.write(`${authTag} ${validAuth(line) ? "OK" : "NO"} authentication\r\n`);
            authTag = undefined;
            continue;
          }
          const [tag, command] = line.split(" ");
          commands.push(command);
          if (command === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n${tag} OK capability\r\n`);
          else if (command === "AUTHENTICATE") {
            if (line.split(" ").length < 4) {
              authTag = tag;
              socket.write("+ \r\n");
            }
            else socket.write(`${tag} ${validAuth(line.split(" ")[3] ?? "") ? "OK" : "NO"} authentication\r\n`);
          }
          else if (command === "LOGIN") socket.write(`${tag} ${options.rejectAuth ? "NO" : "OK"} authentication\r\n`);
          else if (command === "LIST") socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list\r\n`);
          else if (command === "LOGOUT") socket.end(`* BYE closing\r\n${tag} OK logout\r\n`);
          else socket.write(`${tag} OK complete\r\n`);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return {
    port: address.port, commands, sockets, messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
