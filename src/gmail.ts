import type { Gate } from "foxgate";
import { FoxlinkError } from "./errors.js";
import { gated, hasControl, withScope, type Asked, type Refused } from "./gated.js";
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

/** `filename`: ASCII letters, digits, spaces, and `_ . ( ) + , -`. `mimeType`: for example `application/pdf`. */
export type Attachment = { filename: string; mimeType: string; data: Uint8Array };

export interface OutgoingMessage {
  /** One address, or addresses with commas between them. `to`, `cc`, and `bcc` hold 20 addresses at most together. */
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** Plain text, 40,000 characters at most. */
  body: string;
  /** 10 files and 3 MB at most. */
  attachments?: Attachment[];
}

/** Where foxlink records each write. A foxtrail `Log` fits. */
export type TrailLike = { append(entry: { actor: string; kind: string; data: Record<string, unknown> }): Promise<unknown> };

export interface GmailOptions {
  baseUrl?: string;
  gate?: Gate;
  trail?: TrailLike;
  /** `sendMessage` refuses with `draft-only`. `createDraft` still works. */
  draftOnly?: boolean;
  /** True while the run is in private-data mode. Then every send and draft needs an approval that says `privateData: true`. */
  privateMode?: () => boolean | Promise<boolean>;
}

/** `logged: false` when the trail write failed. The mail went out anyway. */
type Written<S> = { status: S; id: string; sha256: string; logged?: false };

/** The args that the human approves. Attachments go in as name, type, size, and hash. */
type Args = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments: { filename: string; mimeType: string; size: number; sha256: string }[] };

const COMPOSE = [GOOGLE_SCOPES.gmailCompose, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const SEND_SCOPES = [GOOGLE_SCOPES.gmailSend, ...COMPOSE];
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
const FILENAME = /^[\w .()+,-]{1,200}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const BOUNDARY = "=_foxlink_mixed";
const utf8 = (text: string) => new TextEncoder().encode(text);
const b64bytes = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const b64 = (text: string) => b64bytes(utf8(text));
const lines = (base64: string) => (base64.match(/.{1,76}/g) ?? []).join("\r\n");
const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, "0")).join("");
const addresses = (value: unknown) => (value === undefined || value === "" ? [] : typeof value === "string" && !hasControl(value) ? value.split(",").map((a) => a.trim()) : undefined);

/** Check a message and make the args to approve. It copies the bytes before its first await (W7). */
async function prepare(m: OutgoingMessage): Promise<{ args: Args; files: Uint8Array[] } | undefined> {
  if (!m || typeof m !== "object") return undefined;
  const [to, cc, bcc] = [addresses(m.to), addresses(m.cc), addresses(m.bcc)];
  if (!to?.length || !cc || !bcc || to.length + cc.length + bcc.length > 20 || ![...to, ...cc, ...bcc].every((a) => ADDRESS.test(a))) return undefined;
  if (typeof m.subject !== "string" || hasControl(m.subject) || m.subject.length > 500 || typeof m.body !== "string" || m.body.length > 40_000) return undefined;
  const list = m.attachments ?? [];
  if (!Array.isArray(list) || list.length > 10) return undefined;
  const files: Uint8Array[] = [];
  for (const a of list) {
    if (!a || typeof a.filename !== "string" || !FILENAME.test(a.filename) || typeof a.mimeType !== "string" || !MIME_TYPE.test(a.mimeType)) return undefined;
    if (Object.prototype.toString.call(a.data) !== "[object Uint8Array]") return undefined;
    files.push(a.data.slice());
  }
  if (files.reduce((n, f) => n + f.length, 0) > 3_000_000) return undefined;
  const attachments = await Promise.all(list.map(async (a, i) => ({ filename: a.filename, mimeType: a.mimeType, size: files[i]?.length ?? 0, sha256: await hex(files[i] ?? new Uint8Array()) })));
  return { args: { to, cc, bcc, subject: m.subject, body: m.body, attachments }, files };
}

/**
 * RFC 2047 encoded words of 75 characters at most, folded on new lines. Each
 * word holds whole characters (45 bytes at most), so no character is split.
 */
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (new TextEncoder().encode(chunk + char).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/** An RFC 5322 message, multipart/mixed with attachments. A non-ASCII subject is RFC 2047 encoded. Base64 never holds the `=_` of the boundary. */
function mime(a: Args, files: Uint8Array[]): string {
  const plain = /^[\x20-\x7e]*$/.test(a.subject) && !a.subject.includes("=?");
  const head = [`To: ${a.to.join(", ")}`, ...(a.cc.length ? [`Cc: ${a.cc.join(", ")}`] : []), ...(a.bcc.length ? [`Bcc: ${a.bcc.join(", ")}`] : []), `Subject: ${plain ? a.subject : encodedWords(a.subject)}`, "MIME-Version: 1.0"];
  const text = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines(b64(a.body))];
  if (!files.length) return [...head, ...text].join("\r\n");
  const parts = a.attachments.flatMap((f, i) => [`--${BOUNDARY}`, `Content-Type: ${f.mimeType}; name="${f.filename}"`, `Content-Disposition: attachment; filename="${f.filename}"`, "Content-Transfer-Encoding: base64", "", lines(b64bytes(files[i] ?? new Uint8Array()))]);
  return [...head, `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`, "", `--${BOUNDARY}`, ...text, ...parts, `--${BOUNDARY}--`, ""].join("\r\n");
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

export function gmail(link: Link, options: GmailOptions = {}) {
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


  async function write(kind: "send" | "draft", { args, files }: { args: Args; files: Uint8Array[] }, token: string | undefined) {
    const post = async (judged: Record<string, unknown>) => {
      const approved = judged as unknown as Args;
      const raw = mime(approved, files);
      const encoded = b64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const body = kind === "send" ? { raw: encoded } : { message: { raw: encoded } };
      const res = await link.fetch(`${base}/users/me/${kind === "send" ? "messages/send" : "drafts"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new FoxlinkError("http-error", `Gmail answered HTTP ${res.status}.`, { status: res.status });
      const id = String(((await res.json()) as { id?: unknown }).id ?? "");
      const sha256 = await hex(utf8(raw));
      const entry = { actor: "foxlink", kind: `gmail.${kind}`, data: { id, to: approved.to, cc: approved.cc, bcc: approved.bcc, sha256 } };
      const logged = await Promise.resolve(options.trail?.append(entry)).then(() => ({}), () => ({ logged: false as const }));
      return { status: kind === "send" ? "sent" : "drafted", id, sha256, ...logged };
    };
    const privateData = Boolean(await options.privateMode?.());
    if (kind === "draft" && !privateData) return post(args as unknown as Record<string, unknown>);
    const action = { tool: `foxlink.gmail.${kind}`, scope: "submit" as const, domain: new URL(base).hostname, args: { ...args, ...(privateData ? { privateData } : {}) } };
    return gated(options.gate, action, token, post, true);
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
     * Send a message, after a human approved it through foxgate (scope `submit`).
     * The first call asks for the `gmail.send` scope if needed, then returns `ask`.
     * Call again with the approval token. One token sends one message.
     */
    async sendMessage(message: OutgoingMessage, approval: { token?: string } = {}): Promise<Written<"sent"> | Asked | Refused> {
      if (options.draftOnly) return { status: "refused", reason: "draft-only" };
      const prepared = await prepare(message);
      if (!prepared) return { status: "refused", reason: "bad-input" };
      return (await withScope(link, SEND_SCOPES, GOOGLE_SCOPES.gmailSend)) ?? (write("send", prepared, approval.token) as Promise<Written<"sent"> | Asked | Refused>);
    },

    /** Save a draft, with no approval. In private-data mode it asks foxgate first, as a send does. */
    async createDraft(message: OutgoingMessage, approval: { token?: string } = {}): Promise<Written<"drafted"> | Asked | Refused> {
      const prepared = await prepare(message);
      if (!prepared) return { status: "refused", reason: "bad-input" };
      return (await withScope(link, COMPOSE, GOOGLE_SCOPES.gmailCompose)) ?? (write("draft", prepared, approval.token) as Promise<Written<"drafted"> | Asked | Refused>);
    },
  });
}

export type Gmail = ReturnType<typeof gmail>;
