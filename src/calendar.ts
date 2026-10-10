import type { Gate } from "foxgate";
import { FoxlinkError } from "./errors.js";
import { gated, hasControl, withScope, type Asked, type Refused } from "./gated.js";
import { ADDRESS } from "./gmail.js";
import type { Link } from "./link.js";
import { GOOGLE_ENDPOINTS, GOOGLE_SCOPES } from "./provider.js";
import { htmlToText, type Untrusted } from "./text.js";

export interface CalendarEvent extends Untrusted {
  source: "calendar";
  summary: string;
  /** An RFC 3339 time, or a date for an all-day event. */
  start: string;
  end: string;
  location: string;
  /** Plain text. HTML is removed. */
  description: string;
}

export interface NewEvent {
  summary: string;
  /** RFC 3339 times with an offset, for example `2026-10-12T09:00:00+02:00`. */
  start: string;
  end: string;
  /** An IANA time zone, for example `Europe/Madrid`. Default: the time zone of the browser. */
  timeZone?: string;
  /** 50 addresses at most. */
  attendees?: string[];
  /** Who gets an invite. Default: `none`, so nobody does. */
  sendUpdates?: "none" | "all" | "externalOnly";
  description?: string;
  location?: string;
}

/** The fields to change. `start`, `end`, and `timeZone` go together. */
export type EventChanges = Partial<NewEvent>;

interface EventResource {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  organizer?: { self?: boolean };
}

const READ_SCOPES = [GOOGLE_SCOPES.calendarRead, GOOGLE_SCOPES.calendarEvents, "https://www.googleapis.com/auth/calendar"];
const WRITE_SCOPES = [GOOGLE_SCOPES.calendarEvents, "https://www.googleapis.com/auth/calendar"];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const toEvent = (e: EventResource): CalendarEvent => ({
  trust: "untrusted",
  source: "calendar",
  id: e.id,
  summary: e.summary ?? "",
  start: e.start?.dateTime ?? e.start?.date ?? "",
  end: e.end?.dateTime ?? e.end?.date ?? "",
  location: e.location ?? "",
  description: htmlToText(e.description ?? ""),
});

const FIELDS = ["summary", "start", "end", "timeZone", "attendees", "sendUpdates", "description", "location"];
const zoneOk = (zone: unknown) => {
  try {
    return typeof zone === "string" && Boolean(new Intl.DateTimeFormat("en", { timeZone: zone }));
  } catch {
    return false;
  }
};

/** Check the fields and make the args to approve. A new event (`whole`) shows every field, with its default. */
function eventArgs(input: EventChanges, whole: boolean): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Object.keys(input).some((k) => !FIELDS.includes(k))) return undefined;
  const e = input as Record<string, unknown>;
  const given = FIELDS.filter((k) => e[k] !== undefined);
  if (whole ? !["summary", "start", "end"].every((k) => given.includes(k)) : !given.some((k) => k !== "sendUpdates")) return undefined;
  if (given.includes("start") !== given.includes("end") || (given.includes("timeZone") && !given.includes("start"))) return undefined;
  if (e.summary !== undefined && (typeof e.summary !== "string" || !e.summary.trim() || e.summary.length > 500 || hasControl(e.summary))) return undefined;
  if (e.start !== undefined && (typeof e.start !== "string" || typeof e.end !== "string" || !RFC3339.test(e.start) || !RFC3339.test(e.end) || !(Date.parse(e.end) > Date.parse(e.start)))) return undefined;
  if ((e.timeZone !== undefined && !zoneOk(e.timeZone)) || (e.sendUpdates !== undefined && !["none", "all", "externalOnly"].includes(String(e.sendUpdates)))) return undefined;
  if (e.attendees !== undefined && (!Array.isArray(e.attendees) || e.attendees.length > 50 || !e.attendees.every((a) => typeof a === "string" && ADDRESS.test(a)))) return undefined;
  if (![e.description, e.location].every((v) => v === undefined || (typeof v === "string" && v.length <= 8000))) return undefined;
  const args: Record<string, unknown> = whole ? { attendees: [], location: "", description: "" } : {};
  for (const k of given) args[k] = e[k];
  if (e.start !== undefined) args.timeZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  args.sendUpdates ??= "none";
  return args;
}

/** The Google event resource for the approved args. */
function resource(a: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  for (const k of ["summary", "description", "location"]) if (a[k] !== undefined) body[k] = a[k];
  if (a.start !== undefined) Object.assign(body, { start: { dateTime: a.start, timeZone: a.timeZone }, end: { dateTime: a.end, timeZone: a.timeZone } });
  if (Array.isArray(a.attendees)) body.attendees = a.attendees.map((email) => ({ email }));
  return body;
}

const clampMax = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), 50) : 10);
const iso = (value: string | Date) => (value instanceof Date ? value : new Date(value)).toISOString();

export function calendar(link: Link, options: { baseUrl?: string; gate?: Gate; calendarId?: string } = {}) {
  const base = options.baseUrl ?? link.provider.endpoints?.calendarBase ?? GOOGLE_ENDPOINTS.calendarBase;
  const events = `${base}/calendars/${encodeURIComponent(options.calendarId ?? "primary")}/events`;
  const hasAny = async (scopes: string[]) => {
    for (const s of scopes) if (await link.hasScope(s)) return true;
    return false;
  };
  const domain = new URL(base).hostname;

  /** Insert or patch, after a human approved the exact args. `sendUpdates` comes from those args only. */
  const write = <S extends string>(tool: string, url: string, method: string, args: Record<string, unknown>, token: string | undefined, status: S) =>
    gated(options.gate, { tool, scope: "submit", domain, args }, token, async (judged) => {
      const target = new URL(url);
      target.searchParams.set("sendUpdates", String(judged.sendUpdates));
      const res = await link.fetch(target, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(resource(judged)) });
      if (!res.ok) throw new FoxlinkError("http-error", `Calendar answered HTTP ${res.status}.`, { status: res.status });
      const done = (await res.json()) as EventResource;
      return { status, id: String(done.id ?? ""), htmlLink: String(done.htmlLink ?? "") };
    }, true);

  return Object.freeze({
    /** The next events from `timeMin` (default: now), by start time. `max` is 1 to 50 (default 10). */
    async listEvents(request: { timeMin?: string | Date; timeMax?: string | Date; max?: number } = {}): Promise<{ events: CalendarEvent[] }> {
      if (!(await hasAny(READ_SCOPES))) throw new FoxlinkError("missing-scope", `This call needs the scope ${GOOGLE_SCOPES.calendarRead}. Connect again and grant it.`);
      const url = new URL(events);
      try {
        url.searchParams.set("timeMin", iso(request.timeMin ?? new Date()));
        if (request.timeMax !== undefined) url.searchParams.set("timeMax", iso(request.timeMax));
      } catch {
        throw new FoxlinkError("bad-input", "timeMin and timeMax must be dates.");
      }
      url.searchParams.set("maxResults", String(clampMax(request.max)));
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      const res = await link.fetch(url);
      if (!res.ok) throw new FoxlinkError("http-error", `Calendar answered HTTP ${res.status}.`, { status: res.status });
      const body = (await res.json()) as { items?: EventResource[] };
      return { events: (body.items ?? []).filter((e) => typeof e.id === "string").map(toEvent) };
    },

    /**
     * Add an event, after a human approved it through foxgate (scope `submit`).
     * The first call asks for `calendar.events` if needed, then returns `ask`.
     */
    async createEvent(event: NewEvent, approval: { token?: string } = {}): Promise<{ status: "created"; id: string; htmlLink: string } | Asked | Refused> {
      const args = eventArgs(event, true);
      if (!args) return { status: "refused", reason: "bad-input" };
      return (await withScope(link, WRITE_SCOPES, GOOGLE_SCOPES.calendarEvents)) ?? write("foxlink.calendar.create", events, "POST", args, approval.token, "created");
    },

    /**
     * Change an event that the user organizes, after an approval. The approval
     * holds the current title, start, and end, so a change at Google gets `action-changed`.
     */
    async patchEvent(id: string, changes: EventChanges, approval: { token?: string } = {}): Promise<{ status: "updated"; id: string; htmlLink: string } | Asked | Refused> {
      const args = eventArgs(changes, false);
      if (typeof id !== "string" || !/^[\w@.-]{1,1024}$/.test(id) || !args) return { status: "refused", reason: "bad-input" };
      const scope = await withScope(link, WRITE_SCOPES, GOOGLE_SCOPES.calendarEvents);
      if (scope) return scope;
      const url = `${events}/${encodeURIComponent(id)}`;
      const res = await link.fetch(url);
      if (!res.ok) throw new FoxlinkError("http-error", `Calendar answered HTTP ${res.status}.`, { status: res.status });
      const found = (await res.json()) as EventResource;
      if (found.organizer?.self !== true) return { status: "refused", reason: "not-own-event" };
      const now = toEvent(found);
      return write("foxlink.calendar.update", url, "PATCH", { eventId: id, current: { summary: now.summary, start: now.start, end: now.end }, ...args }, approval.token, "updated");
    },
  });
}

export type Calendar = ReturnType<typeof calendar>;
