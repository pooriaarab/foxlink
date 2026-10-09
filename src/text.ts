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

const DROP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "iframe", "object", "embed", "math"]);
const BREAK = new Set(["br", "hr"]);
const BLOCK_END = new Set(["p", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "section", "article"]);

/**
 * The index of the ">" that ends the tag at `from`, or the end of the text. One pass.
 * A quote opens a quoted value only right after "=", as in HTML, so `title=it's` has no quote.
 */
function tagEnd(html: string, from: number): number {
  let quote = "";
  let last = "";
  for (let j = from; j < html.length; j += 1) {
    const c = html[j] ?? "";
    if (quote) {
      if (c === quote) quote = "";
    } else if ((c === '"' || c === "'") && last === "=") quote = c;
    else if (c === ">") return j;
    if (!/\s/.test(c)) last = c;
  }
  return html.length;
}

/**
 * Plain text from HTML, with no DOM and no network, in one pass. Scripts,
 * styles, and comments go away with their content. Images and links lose
 * their URLs. Hidden text (for example `display: none`) stays: check it with
 * a tool such as foxshield.
 */
export function htmlToText(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    const name = /^<(\/?)([a-z][a-z0-9]*)/i.exec(html.slice(lt, lt + 40));
    if (!name) {
      out += "<";
      i = lt + 1;
      continue;
    }
    const closing = name[1] === "/";
    const tag = (name[2] ?? "").toLowerCase();
    i = tagEnd(html, lt + 1) + 1;
    if (!closing && DROP.has(tag)) {
      // Only a real close tag ends the block: "</scriptx>" does not.
      const find = new RegExp(`</${tag}(?=[\\s/>]|$)`, "gi");
      find.lastIndex = i;
      const close = find.exec(html)?.index ?? -1;
      i = close === -1 ? html.length : tagEnd(html, close) + 1;
    } else if (BREAK.has(tag) || (closing && BLOCK_END.has(tag))) out += "\n";
    else if (!closing && tag === "li") out += "\n- ";
  }
  return decodeEntities(out)
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
