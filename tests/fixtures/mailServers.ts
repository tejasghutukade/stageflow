import { createServer, type Socket } from "node:net";
import type { MailRecord } from "../../src/email/messages.js";

export async function mailServer(protocol: "imap" | "smtp", options: { rejectAuth?: boolean; stall?: boolean; password?: string; rejectRecipient?: string; dropAfterData?: boolean; stallAfterData?: boolean; mailboxMessages?: MailRecord[] } = {}) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const messages: { data: string; recipients: string[] }[] = [];
  const mailbox = { generation: "1", messages: options.mailboxMessages ?? [] };
  const fetchedSourceBytes: number[] = [];
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
          else if (command === "EXAMINE" || command === "SELECT") {
            if (!line.includes('"INBOX"') && !line.endsWith(" INBOX")) { socket.write(`${tag} NO mailbox missing\r\n`); continue; }
            socket.write(`* FLAGS (\\Seen \\Flagged)\r\n* ${mailbox.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${mailbox.generation}] mailbox identity\r\n* OK [UIDNEXT ${Math.max(0, ...mailbox.messages.map(value => value.uid)) + 1}] next uid\r\n${tag} OK [READ-ONLY] examined\r\n`);
          }
          else if (command === "FETCH" || (command === "UID" && line.includes(" FETCH "))) {
            const uid = command === "UID";
            const requested = Number(line.split(" ")[uid ? 3 : 2]);
            const record = uid ? mailbox.messages.find(value => value.uid === requested) : mailbox.messages[requested - 1];
            if (record) {
              const sequence = mailbox.messages.indexOf(record) + 1;
              const quote = (value: string | undefined): string => value === undefined ? "NIL" : `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, " ")}"`;
              const header = (name: string): string | undefined => record.source.toString("utf8", 0, Math.min(record.source.length, 65536)).match(new RegExp(`^${name}: *(.*)$`, "im"))?.[1]?.trim();
              const address = (value: string | undefined): string => {
                if (!value) return "NIL";
                const email = value.match(/<([^>]+)>/)?.[1] ?? value;
                const [local, domain] = email.split("@");
                return domain ? `((NIL NIL ${quote(local)} ${quote(domain)}))` : "NIL";
              };
              const date = record.receivedAt;
              const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
              const pad = (value: number): string => String(value).padStart(2, "0");
              const internalDate = `${pad(date.getUTCDate())}-${month}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
              const fields = [`UID ${record.uid}`, `FLAGS (${[...record.flags].join(" ")})`, `RFC822.SIZE ${record.source.length}`, `INTERNALDATE "${internalDate}"`];
              if (line.includes("ENVELOPE")) fields.push(`ENVELOPE (NIL ${quote(header("Subject"))} ${address(header("From"))} NIL NIL ${address(header("To"))} NIL NIL NIL ${quote(header("Message-ID"))})`);
              const partial = line.match(/BODY\.PEEK\[\]<([0-9]+)\.([0-9]+)>/i);
              if (partial) {
                const start = Number(partial[1]);
                const source = record.source.subarray(start, start + Number(partial[2]));
                fetchedSourceBytes.push(source.length);
                socket.write(`* ${sequence} FETCH (${fields.join(" ")} BODY[]<${start}> {${source.length}}\r\n`);
                socket.write(source); socket.write(")\r\n");
              } else socket.write(`* ${sequence} FETCH (${fields.join(" ")})\r\n`);
            }
            socket.write(`${tag} OK fetched\r\n`);
          }
          else if (command === "SEARCH" || (command === "UID" && line.includes(" SEARCH "))) {
            const range = line.match(/\bUID (\d+):(\d+)/)?.slice(1).map(Number);
            const matches = mailbox.messages.filter(value => !range || (value.uid >= range[0] && value.uid <= range[1]));
            socket.write(`* SEARCH ${matches.map(value => value.uid).join(" ")}\r\n${tag} OK searched\r\n`);
          }
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
    port: address.port, commands, sockets, messages, mailbox, fetchedSourceBytes,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
