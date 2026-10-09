import type { Gate } from "foxgate";
import { FoxlinkError } from "./errors.js";
import { FOXLINK_TOOLS, gated, hasControl, type Asked, type Refused } from "./gated.js";
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
  /** RFC 3339 times, for example `2026-10-12T09:00:00Z`. */
  start: string;
  end: string;
  description?: string;
  location?: string;
}

interface EventResource {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
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

function validEvent(e: NewEvent): boolean {
  if (!e || typeof e.summary !== "string" || !e.summary.trim() || e.summary.length > 500 || hasControl(e.summary)) return false;
  if (typeof e.start !== "string" || typeof e.end !== "string" || !RFC3339.test(e.start) || !RFC3339.test(e.end)) return false;
  if (!(Date.parse(e.end) > Date.parse(e.start))) return false;
  return [e.description, e.location].every((v) => v === undefined || (typeof v === "string" && v.length <= 8000));
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

    /** Add an event, after a foxgate decision with scope `submit`. The first call returns `ask`. */
    async createEvent(event: NewEvent, approval: { token?: string } = {}): Promise<{ status: "created"; id: string; htmlLink: string } | Asked | Refused> {
      if (!validEvent(event)) return { status: "refused", reason: "bad-input" };
      if (!(await hasAny(WRITE_SCOPES))) return { status: "refused", reason: "missing-scope" };
      const args: Record<string, unknown> = { summary: event.summary, start: event.start, end: event.end };
      if (event.description !== undefined) args.description = event.description;
      if (event.location !== undefined) args.location = event.location;
      const action = { tool: "foxlink.calendar.create", scope: FOXLINK_TOOLS["foxlink.calendar.create"], domain: new URL(base).hostname, args };
      return gated(options.gate, action, approval.token, async (judged) => {
        const body = { summary: judged.summary, description: judged.description, location: judged.location, start: { dateTime: judged.start }, end: { dateTime: judged.end } };
        const res = await link.fetch(events, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new FoxlinkError("http-error", `Calendar answered HTTP ${res.status}.`, { status: res.status });
        const created = (await res.json()) as EventResource;
        return { status: "created" as const, id: String(created.id ?? ""), htmlLink: String(created.htmlLink ?? "") };
      });
    },
  });
}

export type Calendar = ReturnType<typeof calendar>;
