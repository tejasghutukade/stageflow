import { authorizationHeaders } from "../api/controlToken";
import type { DialogAnswerBody } from "./dialogState";
import type { LiveViewInput, LiveViewMode } from "./types";
import type { TicketResult } from "./connection";

export const LIVE_VIEW_CSRF_HEADER = "x-stageflow-live-view";

export async function requestLiveViewTicket(baseUrl: string, mode: LiveViewMode): Promise<TicketResult> {
  const res = await fetch(`${baseUrl}/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) return { status: res.status };
  const body = (await res.json().catch(() => ({}))) as { ticket?: unknown };
  return typeof body.ticket === "string" ? { ticket: body.ticket } : { status: 502 };
}

export async function postLiveViewInput(baseUrl: string, batch: LiveViewInput[]): Promise<number> {
  const res = await fetch(`${baseUrl}/input`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", [LIVE_VIEW_CSRF_HEADER]: "1" },
    body: JSON.stringify(batch),
  });
  return res.status;
}

export async function postLiveViewDialog(baseUrl: string, body: DialogAnswerBody): Promise<number> {
  const res = await fetch(`${baseUrl}/dialog`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", [LIVE_VIEW_CSRF_HEADER]: "1" },
    body: JSON.stringify(body),
  });
  return res.status;
}

export async function postLiveViewReopenTab(baseUrl: string): Promise<number> {
  const res = await fetch(`${baseUrl}/reopen-tab`, {
    method: "POST",
    credentials: "same-origin",
    headers: { [LIVE_VIEW_CSRF_HEADER]: "1" },
  });
  return res.status;
}
