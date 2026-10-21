import type { ChannelContact } from "../../../api/agents";

export type ContactLine = { tone: "ok" | "warn" | "muted"; text: string };

const digits = (value: string) => value.replace(/[^\d+]/g, "");

/**
 * What to tell the owner about reaching an iMessage agent: the number to text, or for a shared Photon line the
 * number each allowed person was assigned, and who is not registered (so cannot text it at all).
 */
export function contactLines(contact: ChannelContact, allowFrom: readonly string[]): ContactLine[] {
  if (!contact.ok) return [{ tone: "muted", text: `Could not look up the number: ${contact.error}` }];
  if (contact.kind === "dedicated") {
    if (contact.numbers.length === 0) return [{ tone: "muted", text: "This Photon project has no line yet." }];
    return [
      { tone: "ok", text: contact.numbers.length === 1 ? `Text ${contact.numbers[0]} to reach this agent.` : `Text any of ${contact.numbers.join(", ")} to reach this agent.` },
    ];
  }
  const lines: ContactLine[] = [];
  const phones = allowFrom.filter((entry) => /^\+\d/.test(entry));
  const byPhone = new Map(contact.users.map((user) => [digits(user.phone), user]));
  for (const phone of phones) {
    const user = byPhone.get(digits(phone));
    if (!user) lines.push({ tone: "warn", text: `${phone} is not registered in your Photon project, so it cannot text this agent. Add it as a user in the Photon dashboard.` });
    else if (!user.assignedNumber) lines.push({ tone: "warn", text: `${user.name ?? phone} is registered but has no number assigned yet.` });
    else lines.push({ tone: "ok", text: `${user.name ? `${user.name} (${phone})` : phone} texts ${user.assignedNumber}.` });
  }
  if (phones.length === 0) {
    const shown = contact.users.filter((user) => user.assignedNumber).slice(0, 5);
    for (const user of shown) lines.push({ tone: "ok", text: `${user.name ? `${user.name} (${user.phone})` : user.phone} texts ${user.assignedNumber}.` });
    if (shown.length === 0) lines.push({ tone: "warn", text: "No one is registered in this Photon project yet. Add the people who should text the agent in the Photon dashboard." });
  }
  lines.push({ tone: "muted", text: "On a shared line each person texts the number Photon assigned to them, and must text it once before the agent can answer." });
  return lines;
}
