// Failure modes K1-K9 in docs/failure-modes.md: Calendar writes.
import { createFoxgate } from "foxgate";
import { describe, expect, it } from "vitest";
import { FOXLINK_TOOLS, calendar } from "../src/index.js";
import { SCOPE, setup } from "./helpers.js";

const READ = [SCOPE.gmailRead, SCOPE.calRead];
const ev = { summary: "Design review", start: "2026-10-12T09:00:00+02:00", end: "2026-10-12T10:00:00+02:00", timeZone: "Europe/Madrid", attendees: ["ana@example.com", "bo@example.com"], location: "Room 4" };
const mine = { id: "own1", summary: "Dentist", start: { dateTime: "2026-10-13T09:00:00Z" }, end: { dateTime: "2026-10-13T09:30:00Z" }, organizer: { email: "me@example.com", self: true } };
const theirs = { id: "boss1", summary: "All hands", start: { dateTime: "2026-10-14T09:00:00Z" }, end: { dateTime: "2026-10-14T10:00:00Z" }, organizer: { email: "boss@example.com" } };

async function env(approval: "always" | "never" = "always") {
  const e = await setup({ provider: { allowedScopes: [...READ, SCOPE.calWrite] } });
  e.g.addEvents([structuredClone(mine), structuredClone(theirs)]);
  await e.link.connect({ scopes: READ });
  const { gate, host } = createFoxgate({ tools: FOXLINK_TOOLS });
  await host.addGrant({ scope: "submit", domains: ["www.localhost"], approval });
  const approve = async (ask: { status: string; requestId?: string }) => {
    expect(ask.status).toBe("ask");
    const text = (await host.pending()).find((r) => r.id === ask.requestId)?.text ?? "";
    return { token: await host.approve(ask.requestId ?? ""), args: JSON.parse(text).args };
  };
  return { ...e, host, approve, cal: calendar(e.link, { gate }) };
}

describe("calendar writes", () => {
  it("K1, K2, K3: consent once, show the whole event, and send no invites", async () => {
    const e = await env();
    const { token, args } = await e.approve(await e.cal.createEvent(ev));
    expect(new URL(e.launches[1] ?? "").searchParams.get("scope")?.split(" ")).toEqual([...READ, SCOPE.calWrite]);
    expect(args).toEqual({ ...ev, sendUpdates: "none", description: "" });
    expect(await e.cal.createEvent(ev, { token })).toMatchObject({ status: "created" });
    expect(e.launches).toHaveLength(2);
    expect(e.g.writes).toEqual([{ method: "POST", sendUpdates: "none", id: expect.any(String) }]);
    expect(e.g.events.at(-1)).toMatchObject({ summary: "Design review", start: { dateTime: ev.start, timeZone: "Europe/Madrid" }, attendees: [{ email: "ana@example.com" }, { email: "bo@example.com" }] });
    expect(e.g.invites).toEqual([]);

    const loud = { ...ev, sendUpdates: "all" as const };
    const second = await e.approve(await e.cal.createEvent(loud));
    expect(second.args.sendUpdates).toBe("all");
    await e.cal.createEvent(loud, { token: second.token });
    expect(e.g.invites.map((i: { to: string }) => i.to)).toEqual(["ana@example.com", "bo@example.com"]);
  });

  it("K4, K5: changed attendees or sendUpdates after the approval, or no human: refused", async () => {
    const e = await env();
    for (const changed of [{ ...ev, attendees: [...ev.attendees, "eve@example.com"] }, { ...ev, sendUpdates: "all" as const }]) {
      const { token } = await e.approve(await e.cal.createEvent(ev));
      expect(await e.cal.createEvent(changed, { token })).toEqual({ status: "refused", reason: "action-changed" });
    }
    expect(e.g.writes).toEqual([]);
    const never = await env("never");
    expect(await never.cal.createEvent(ev)).toEqual({ status: "refused", reason: "approval-required" });
  });

  it("K6: bad input is refused before the gate", async () => {
    const e = await env();
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@example.com`);
    for (const bad of [{ timeZone: "Mars/Base" }, { attendees: ["not an address"] }, { attendees: many }, { sendUpdates: "loud" }, { attendees: "ana@example.com" }]) {
      expect(await e.cal.createEvent({ ...ev, ...bad } as typeof ev)).toEqual({ status: "refused", reason: "bad-input" });
    }
    expect(await e.host.pending()).toEqual([]);
  });

  it("K7, K8: patch only your own events, only shown fields, and never delete", async () => {
    const e = await env();
    expect(await e.cal.patchEvent("boss1", { summary: "Cancelled" })).toEqual({ status: "refused", reason: "not-own-event" });
    for (const bad of [{ status: "cancelled" }, {}, { start: "2026-10-13T10:00:00Z" }]) expect(await e.cal.patchEvent("own1", bad as never)).toEqual({ status: "refused", reason: "bad-input" });
    expect(await e.host.pending()).toEqual([]);
    expect(Object.keys(e.cal)).toEqual(["listEvents", "createEvent", "patchEvent"]);

    const move = { start: "2026-10-13T11:00:00Z", end: "2026-10-13T11:30:00Z", timeZone: "UTC" };
    const { token, args } = await e.approve(await e.cal.patchEvent("own1", move));
    expect(args).toEqual({ eventId: "own1", current: { summary: "Dentist", start: mine.start.dateTime, end: mine.end.dateTime }, ...move, sendUpdates: "none" });
    expect(await e.cal.patchEvent("own1", move, { token })).toMatchObject({ status: "updated", id: "own1" });
    expect(e.g.events.find((x: { id: string }) => x.id === "own1")).toMatchObject({ summary: "Dentist", status: "confirmed", start: { dateTime: move.start, timeZone: "UTC" } });
    expect(e.g.writes).toEqual([{ method: "PATCH", sendUpdates: "none", id: "own1" }]);
  });

  it("K9: the event changed at Google after the approval: action-changed", async () => {
    const e = await env();
    const { token } = await e.approve(await e.cal.patchEvent("own1", { summary: "Dentist at 10" }));
    e.g.events.find((x: { id: string }) => x.id === "own1").summary = "Dentist (moved by Ana)";
    expect(await e.cal.patchEvent("own1", { summary: "Dentist at 10" }, { token })).toEqual({ status: "refused", reason: "action-changed" });
    expect(e.g.writes).toEqual([]);
  });
});
