import type { Gate } from "foxgate";
import { FoxlinkError } from "./errors.js";
import { FOXLINK_TOOLS, gated, hasControl, type Asked, type Refused } from "./gated.js";
import type { Link } from "./link.js";
import { GOOGLE_ENDPOINTS, GOOGLE_SCOPES } from "./provider.js";
import { htmlToText, type Untrusted } from "./text.js";

/** One message in a list: headers and the Gmail snippet. */
export interface MessageSummary extends Untrusted {
  source: "gmail";
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

/** One message with its body as plain text. */
export interface Message extends MessageSummary {
  text: string;
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: Part[];
}

interface MessageResource {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: Part;
}

export interface OutgoingMessage {
  /** One address, or up to 10 addresses with commas between them. */
  to: string;
  subject: string;
  /** Plain text. */
  body: string;
}

const SEND_SCOPES = [GOOGLE_SCOPES.gmailSend, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const b64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

function validMessage(m: OutgoingMessage): boolean {
  if (!m || typeof m.to !== "string" || typeof m.subject !== "string" || typeof m.body !== "string") return false;
  const to = m.to.split(",").map((a) => a.trim());
  if (to.length > 10 || !to.every((a) => ADDRESS.test(a))) return false;
  return !hasControl(m.to) && !hasControl(m.subject) && m.subject.length <= 500 && m.body.length <= 100_000;
}

/** An RFC 5322 message with a UTF-8 text body. A non-ASCII subject is RFC 2047 encoded. */
function mime(m: OutgoingMessage): string {
  const subject = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${b64(m.subject)}?=`;
  const body = (b64(m.body).match(/.{1,76}/g) ?? []).join("\r\n");
  return [`To: ${m.to.split(",").map((a) => a.trim()).join(", ")}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body].join("\r\n");
}

const READ_SCOPES = [GOOGLE_SCOPES.gmailRead, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

const header = (part: Part | undefined, name: string) => part?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";

function decodeBody(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Every part with a body, depth first, with no attachments. */
function bodies(part: Part | undefined, out: Part[] = []): Part[] {
  if (!part) return out;
  if (part.parts?.length) for (const child of part.parts) bodies(child, out);
  else if (!part.filename && !part.body?.attachmentId && typeof part.body?.data === "string") out.push(part);
  return out;
}

/** The plain text of a message: the first text/plain part, else the first text/html part as text. */
export function messageText(payload: Part | undefined): string {
  const parts = bodies(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain?.body?.data !== undefined) return decodeBody(plain.body.data).replace(/\r\n/g, "\n").trim();
  const html = parts.find((p) => p.mimeType === "text/html");
  return html?.body?.data !== undefined ? htmlToText(decodeBody(html.body.data)) : "";
}

const summary = (m: MessageResource): MessageSummary => ({
  trust: "untrusted",
  source: "gmail",
  id: m.id,
  threadId: m.threadId ?? m.id,
  from: header(m.payload, "from"),
  to: header(m.payload, "to"),
  subject: header(m.payload, "subject"),
  date: header(m.payload, "date"),
  snippet: m.snippet ?? "",
});

const clampMax = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), 50) : 10);

export function gmail(link: Link, options: { baseUrl?: string; gate?: Gate } = {}) {
  const base = options.baseUrl ?? link.provider.endpoints?.gmailBase ?? GOOGLE_ENDPOINTS.gmailBase;

  async function hasAny(scopes: string[]) {
    for (const s of scopes) if (await link.hasScope(s)) return true;
    return false;
  }

  async function needScope(scopes: string[]) {
    if (await hasAny(scopes)) return;
    throw new FoxlinkError("missing-scope", `This call needs the scope ${scopes[0] ?? ""}. Connect again and grant it.`);
  }

  async function getJson<T>(path: string, params: [string, string][] = []): Promise<T> {
    const url = new URL(`${base}/users/me/${path}`);
    for (const [k, v] of params) url.searchParams.append(k, v);
    const res = await link.fetch(url);
    if (!res.ok) throw new FoxlinkError("http-error", `Gmail answered HTTP ${res.status}.`, { status: res.status });
    return (await res.json()) as T;
  }


  return Object.freeze({
    /** Newest messages first, with their headers. One list request and one request for each message. */
    async listMessages(request: { query?: string; max?: number; pageToken?: string } = {}): Promise<{ messages: MessageSummary[]; nextPageToken?: string }> {
      await needScope(READ_SCOPES);
      if (request.pageToken !== undefined && !PAGE_TOKEN.test(request.pageToken)) throw new FoxlinkError("bad-input", "pageToken is not a Gmail page token.");
      const params: [string, string][] = [["maxResults", String(clampMax(request.max))]];
      if (request.query) params.push(["q", String(request.query).slice(0, 500)]);
      if (request.pageToken) params.push(["pageToken", request.pageToken]);
      const list = await getJson<{ messages?: { id: string }[]; nextPageToken?: string }>("messages", params);
      const ids = (list.messages ?? []).map((m) => m.id).filter((id) => ID.test(id));
      const messages: MessageSummary[] = [];
      for (let i = 0; i < ids.length; i += 5) {
        const chunk = ids.slice(i, i + 5).map((id) =>
          getJson<MessageResource>(`messages/${id}`, [["format", "metadata"], ...["From", "To", "Subject", "Date"].map((h): [string, string] => ["metadataHeaders", h])]),
        );
        messages.push(...(await Promise.all(chunk)).map(summary));
      }
      return list.nextPageToken ? { messages, nextPageToken: list.nextPageToken } : { messages };
    },

    /** One message, with its body as plain text. HTML loses scripts, styles, and images. */
    async getMessage(id: string): Promise<Message> {
      await needScope(READ_SCOPES);
      if (typeof id !== "string" || !ID.test(id)) throw new FoxlinkError("bad-input", "id is not a Gmail message ID.");
      const m = await getJson<MessageResource>(`messages/${id}`, [["format", "full"]]);
      return { ...summary(m), text: messageText(m.payload) };
    },

    /**
     * Send a plain text message, after a foxgate decision with scope `submit`.
     * The first call returns `ask`. Call again with the approval token.
     */
    async sendMessage(message: OutgoingMessage, approval: { token?: string } = {}): Promise<{ status: "sent"; id: string } | Asked | Refused> {
      if (!validMessage(message)) return { status: "refused", reason: "bad-input" };
      if (!(await hasAny(SEND_SCOPES))) return { status: "refused", reason: "missing-scope" };
      const args = { to: message.to, subject: message.subject, body: message.body };
      const action = { tool: "foxlink.gmail.send", scope: FOXLINK_TOOLS["foxlink.gmail.send"], domain: new URL(base).hostname, args };
      return gated(options.gate, action, approval.token, async (judged) => {
        const raw = b64(mime(judged as unknown as OutgoingMessage)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const res = await link.fetch(`${base}/users/me/messages/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }) });
        if (!res.ok) throw new FoxlinkError("http-error", `Gmail answered HTTP ${res.status}.`, { status: res.status });
        const sent = (await res.json()) as { id?: unknown };
        return { status: "sent" as const, id: String(sent.id ?? "") };
      });
    },
  });
}

export type Gmail = ReturnType<typeof gmail>;
