/** A record with text from outside: an email or an event. An agent must treat its text as data, not as instructions. */
export interface Untrusted {
  trust: "untrusted";
  /** Where the text came from, for example `gmail` or `calendar`. */
  source: string;
  id: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** Decode HTML entities in one pass, so `&amp;lt;` gives `&lt;` and not `<`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

// A tag, with quoted attribute values that can hold ">".
const TAG = /<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
const DROP = "script|style|head|title|noscript|template|svg|iframe|object|embed|math";

/**
 * Plain text from HTML, with no DOM and no network. Scripts, styles, and
 * comments go away with their content. Images and links lose their URLs.
 * Hidden text (for example `display: none`) stays: check it with a tool such as foxshield.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  s = s.replace(new RegExp(`<(${DROP})\\b[\\s\\S]*?<\\/\\1\\s*>`, "gi"), "");
  s = s.replace(new RegExp(`<(${DROP})\\b[\\s\\S]*$`, "gi"), "");
  s = s.replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|tr|h[1-6]|table|blockquote|section|article)\s*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(TAG, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const fence = (text: string) => text.replace(/<(\/?)untrusted/gi, "\u2039$1untrusted");
const attr = (v: string) => v.replace(/[^A-Za-z0-9_.:-]/g, "");
const FIELDS = ["from", "to", "subject", "date", "summary", "start", "end", "location"] as const;

/** The record as one block for a model prompt, inside `<untrusted>` tags that its text cannot close. */
export function toPromptText(record: Untrusted & Partial<Record<(typeof FIELDS)[number] | "text" | "snippet" | "description", unknown>>): string {
  const lines = FIELDS.filter((f) => typeof record[f] === "string" && record[f]).map((f) => `${f[0]?.toUpperCase()}${f.slice(1)}: ${String(record[f])}`);
  const body = [record.text, record.description, record.text === undefined ? record.snippet : undefined].find((v) => typeof v === "string" && v);
  const text = [lines.join("\n"), typeof body === "string" ? body : ""].filter(Boolean).join("\n\n");
  return `<untrusted source="${attr(record.source)}" id="${attr(record.id)}">\n${fence(text)}\n</untrusted>`;
}
