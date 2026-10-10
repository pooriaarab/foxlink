// Failure modes W1-W13 in docs/failure-modes.md: send and drafts.
import { createHash } from "node:crypto";
import { createFoxgate } from "foxgate";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { describe, expect, it } from "vitest";
import { FOXLINK_TOOLS, gmail } from "../src/index.js";
import { SCOPE, setup } from "./helpers.js";

const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const READ = [SCOPE.gmailRead, SCOPE.calRead];
const bytes = (text: string) => new TextEncoder().encode(text);
const mail1 = { to: "bob@example.com", cc: "cy@example.com", bcc: "dee@example.com", subject: "Notes", body: "Here are the notes.\nAna", attachments: [{ filename: "notes.txt", mimeType: "text/plain", data: bytes("line 1\nline 2\n") }] };
const file = (filename: string, mimeType: string, data: unknown) => ({ attachments: [{ filename, mimeType, data }] });
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function env(options: { allowed?: string[]; approval?: "always" | "never"; mail?: Record<string, unknown> } = {}) {
  const e = await setup({ provider: { allowedScopes: options.allowed ?? [...READ, SCOPE.gmailSend, COMPOSE] } });
  await e.link.connect({ scopes: READ });
  const { gate, host } = createFoxgate({ tools: FOXLINK_TOOLS });
  await host.addGrant({ scope: "submit", domains: ["gmail.localhost"], approval: options.approval ?? "always" });
  const trail = new Log({ store: new MemoryStore(), key: await generateKey() });
  return { ...e, host, trail, mail: gmail(e.link, { gate, trail, ...options.mail }) };
}

/** Ask, approve, and return the token and the approval text. */
async function approve(e: Awaited<ReturnType<typeof env>>, ask: { status: string; requestId?: string }) {
  expect(ask.status).toBe("ask");
  const text = (await e.host.pending()).find((r) => r.id === ask.requestId)?.text ?? "";
  return { token: await e.host.approve(ask.requestId ?? ""), args: JSON.parse(text).args };
}

describe("send and drafts", () => {
  it("W1: a send without gmail.send asks for consent one time, then asks the gate", async () => {
    const e = await env();
    const ask = await e.mail.sendMessage(mail1);
    expect(e.launches).toHaveLength(2);
    expect(new URL(e.launches[1] ?? "").searchParams.get("scope")?.split(" ")).toEqual([...READ, SCOPE.gmailSend]);
    expect((await e.link.status()).scopes).toEqual([...READ, SCOPE.gmailSend]);
    const { token } = await approve(e, ask);
    expect(await e.mail.sendMessage(mail1, { token })).toMatchObject({ status: "sent" });
    expect(e.launches).toHaveLength(2);
    expect(e.g.sent).toHaveLength(1);
  });

  it("W2, W4: no consent outside allowedScopes, and no send with no human", async () => {
    const e = await env({ allowed: READ });
    expect(await e.mail.sendMessage(mail1)).toEqual({ status: "refused", reason: "missing-scope" });
    expect(e.launches).toHaveLength(1);
    const never = await env({ approval: "never" });
    expect(await never.mail.sendMessage(mail1)).toEqual({ status: "refused", reason: "approval-required" });
    expect(never.g.sent).toEqual([]);
  });

  it("W3: the user denies the extra consent: access-denied, reads still work", async () => {
    const e = await env();
    e.g.behavior.consent = "deny";
    expect(await e.mail.sendMessage(mail1)).toEqual({ status: "refused", reason: "access-denied" });
    expect((await e.link.status()).scopes).toEqual(READ);
    expect((await e.mail.listMessages()).messages).toEqual([]);
  });

  it("W5, W10: the approval shows every recipient and attachment; the trail keeps a hash", async () => {
    const e = await env();
    const { token, args } = await approve(e, await e.mail.sendMessage(mail1));
    expect(args).toEqual({
      to: ["bob@example.com"], cc: ["cy@example.com"], bcc: ["dee@example.com"], subject: "Notes", body: mail1.body,
      attachments: [{ filename: "notes.txt", mimeType: "text/plain", size: 14, sha256: sha(mail1.attachments[0]?.data ?? "") }],
    });
    const sent = await e.mail.sendMessage(mail1, { token });
    const raw: string = e.g.sent[0].raw;
    for (const part of ["Cc: cy@example.com\r\n", "Bcc: dee@example.com\r\n", 'filename="notes.txt"', Buffer.from("line 1\nline 2\n").toString("base64")]) expect(raw).toContain(part);
    expect(sent).toEqual({ status: "sent", id: e.g.sent[0].id, sha256: sha(raw) });
    expect(await e.trail.verify()).toMatchObject({ ok: true, count: 1 });
    const entry = JSON.parse(await e.trail.exportJsonl());
    expect(entry).toMatchObject({ actor: "foxlink", kind: "gmail.send", data: { id: e.g.sent[0].id, to: ["bob@example.com"], cc: ["cy@example.com"], bcc: ["dee@example.com"], sha256: sha(raw) } });
    for (const secret of ["Notes", "Here are the notes", "line 1", Buffer.from("line 1\nline 2\n").toString("base64")]) expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("W6, W7: a changed byte after the approval is refused; a change during the send is not sent", async () => {
    const e = await env();
    const withData = (data: Uint8Array) => ({ ...mail1, attachments: [{ ...mail1.attachments[0], data }] }) as typeof mail1;
    const first = await approve(e, await e.mail.sendMessage(mail1));
    expect(await e.mail.sendMessage(withData(bytes("line 1\nline 3\n")), { token: first.token })).toEqual({ status: "refused", reason: "action-changed" });
    expect(e.g.sent).toEqual([]);
    const { token } = await approve(e, await e.mail.sendMessage(mail1));
    const data = bytes("line 1\nline 2\n");
    const running = e.mail.sendMessage(withData(data), { token });
    data.fill(65);
    expect((await running).status).toBe("sent");
    expect(e.g.sent[0].raw).toContain(Buffer.from("line 1\nline 2\n").toString("base64"));
  });

  it("W8, W9: bad or too big input is refused before the gate", async () => {
    const e = await env();
    const many = Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.txt`, mimeType: "text/plain", data: bytes("x") }));
    for (const bad of [
      { cc: "cy@example.com\r\nBcc: evil@example.com" }, { bcc: "not an address" }, file('a"\r\nX: y.txt', "text/plain", bytes("x")), file("a.txt", "text/plain\r\nX: y", bytes("x")), file("a.txt", "text/plain", "x"),
      { body: "x".repeat(40_001) }, { to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(",") }, { attachments: many }, file("big.bin", "application/octet-stream", new Uint8Array(3_000_001)),
    ]) {
      expect(await e.mail.sendMessage({ ...mail1, ...bad } as typeof mail1)).toEqual({ status: "refused", reason: "bad-input" });
    }
    expect(await e.host.pending()).toEqual([]);
  });

  it("W11: a trail write that fails after the send gives logged: false and no second send", async () => {
    const e = await env({ mail: { trail: { append: () => Promise.reject(new Error("disk full")) } } });
    const { token } = await approve(e, await e.mail.sendMessage(mail1));
    expect(await e.mail.sendMessage(mail1, { token })).toMatchObject({ status: "sent", logged: false });
    expect(e.g.sent).toHaveLength(1);
  });

  it("W12: draft-only mode saves drafts with no approval and never sends", async () => {
    const e = await env({ mail: { draftOnly: true } });
    expect(await e.mail.sendMessage(mail1)).toEqual({ status: "refused", reason: "draft-only" });
    expect(e.launches).toHaveLength(1);
    const drafted = await e.mail.createDraft(mail1);
    expect(drafted).toMatchObject({ status: "drafted", id: e.g.drafts[0].id });
    expect(new URL(e.launches[1] ?? "").searchParams.get("scope")?.split(" ")).toEqual([...READ, COMPOSE]);
    expect(e.g.drafts[0].raw).toContain("Bcc: dee@example.com\r\n");
    expect(e.g.sent).toEqual([]);
    expect(await e.host.pending()).toEqual([]);
  });

  it("W13: private-data mode needs an approval that says so", async () => {
    let privateMode = false;
    const e = await env({ mail: { privateMode: () => privateMode } });
    const { token } = await approve(e, await e.mail.sendMessage(mail1));
    privateMode = true;
    expect(await e.mail.sendMessage(mail1, { token })).toEqual({ status: "refused", reason: "action-changed" });
    const asked = await approve(e, await e.mail.sendMessage(mail1));
    expect(asked.args.privateData).toBe(true);
    expect((await e.mail.sendMessage(mail1, { token: asked.token })).status).toBe("sent");
    expect((await e.mail.createDraft(mail1)).status).toBe("ask");
    expect(e.g.sent).toHaveLength(1);
    expect(e.g.drafts).toEqual([]);
  });
});
