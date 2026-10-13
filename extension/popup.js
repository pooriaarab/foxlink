// The demo popup. It sends messages to the background and shows text only
// (textContent), so email HTML never renders and remote images never load.
const $ = (id) => document.getElementById(id);
let waiting;

async function call(type, data = {}) {
  const answer = await browser.runtime.sendMessage({ type, ...data });
  if (answer?.error) throw new Error(answer.error);
  return answer.ok;
}

function show(id, text) {
  $(id).textContent = text;
  // Connected: the dot turns green and Connect is no longer the primary.
  if (id === "status") {
    $(id).parentElement.classList.toggle("on", text !== "Not connected");
    $("connect").classList.toggle("primary", text === "Not connected");
  }
  $(id).dataset.runs = String(Number($(id).dataset.runs ?? 0) + 1);
}

const statusText = (s) => (s.connected ? `Connected (${s.scopes.map((x) => x.split("/").pop()).join(", ")})` : "Not connected");
const message = async () => ({
  ...Object.fromEntries(["to", "cc", "bcc", "subject", "body"].map((id) => [id, $(id).value])),
  attachments: await Promise.all([...$("files").files].map(async (f) => ({ filename: f.name, mimeType: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) }))),
});

const shown = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? `${x.filename} (${x.mimeType}, ${x.size} bytes, SHA-256 ${x.sha256})` : x)).join(", ") || "(none)" : String(v));
const draftEvent = () => ({
  summary: $("summary").value,
  ...Object.fromEntries(["start", "end"].map((id) => [id, $(id).value && new Date($(id).value).toISOString()])),
  ...($("time-zone").value.trim() ? { timeZone: $("time-zone").value.trim() } : {}),
  attendees: $("attendees").value.split(",").map((a) => a.trim()).filter(Boolean),
  ...($("location").value ? { location: $("location").value } : {}),
  sendUpdates: $("invite").checked ? "all" : "none",
});
const forms = { send: async () => ({ message: await message() }), event: async () => ({ event: draftEvent() }) };

const ORDER = ["to", "cc", "bcc", "subject", "body", "attachments", "privateData", "summary", "start", "end", "timeZone", "attendees", "sendUpdates", "location", "description"];
const rank = (key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
// A start or end also shows as a wall clock time in the approved time zone.
const clock = (iso, zone) => `${iso} (${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(iso))} in ${zone})`;
// A letter avatar for the service. The hue comes from the name; setProperty
// is CSSOM, which the default extension CSP allows.
function siteIcon(site) {
  const box = Object.assign(document.createElement("span"), { className: "site-icon", textContent: (site[0] ?? "?").toUpperCase() });
  let hue = 0;
  for (const c of site) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  box.style.setProperty("--hue", String(hue));
  box.setAttribute("aria-hidden", "true");
  return box;
}
const el = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent });
const ASKS = { send: ["Gmail", "Send this email."], event: ["Google Calendar", "Add this event to your calendar."] };
function approval(kind, args) {
  const rows = document.createElement("dl");
  for (const [k, v] of Object.entries(args).toSorted(([a], [b]) => rank(a) - rank(b))) {
    const text = ["start", "end"].includes(k) && args.timeZone ? clock(v, args.timeZone) : shown(v);
    rows.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: text }));
  }
  const [site, line] = ASKS[kind];
  const head = el("div", "ask-head");
  head.append(siteIcon(site), el("span", "site", site));
  $("pending").replaceChildren(head, el("p", "what", line), rows);
}
const outcome = (r) => (r.reason ? `${r.status}: ${r.reason}` : r.status[0].toUpperCase() + r.status.slice(1));

// Ask for a send or an event. The popup shows the args that foxgate holds.
async function propose(kind) {
  const r = await call(kind, await forms[kind]());
  if (r.status === "ask") {
    waiting = { kind, requestId: r.requestId };
    approval(kind, r.args);
    $("approve").hidden = $("deny").hidden = $("ask").hidden = false;
  }
  show("result", r.status === "ask" ? "Waiting for approval" : outcome(r));
}

function list(items) {
  $("list").replaceChildren(...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
  show("result", `${items.length} shown`);
}

const actions = {
  save: async () => {
    const value = { clientId: $("client-id").value.trim(), clientSecret: $("client-secret").value, testPort: $("test-port").value.trim() };
    await call("saveSettings", { value });
    show("result", "Saved");
  },
  connect: async () => show("status", statusText(await call("connect"))),
  disconnect: async () => {
    const { revoked } = await call("disconnect");
    show("status", "Not connected");
    show("result", revoked ? "Revoked at the provider" : "Forgotten here, revoke failed");
  },
  events: async () => list((await call("events")).map((e) => `${e.start} ${e.summary}`)),
  subjects: async () => list((await call("subjects")).map((m) => `${m.subject} (${m.from})`)),
  read: async () => {
    const [latest] = await call("subjects");
    const m = latest ? await call("read", { id: latest.id }) : { subject: "", text: "No email." };
    show("text", `${m.subject}\n\n${m.text}`);
    show("result", "Read");
  },
  send: () => propose("send"),
  event: () => propose("event"),
  approve: async () => {
    const { token } = await call("approve", waiting);
    $("approve").hidden = $("deny").hidden = $("ask").hidden = true;
    show("result", outcome(await call(waiting.kind, { ...(await forms[waiting.kind]()), token })));
  },
  deny: async () => {
    await call("deny", waiting);
    $("approve").hidden = $("deny").hidden = $("ask").hidden = true;
    show("result", "Denied");
  },
};

for (const [id, run] of Object.entries(actions)) {
  $(id).addEventListener("click", () => run().catch((error) => show("result", error.message)));
}

// Only the e2e build (build-ext.mjs --e2e) talks to a local server.
if (globalThis.FOXLINK_E2E) $("local-server").hidden = false;

call("getSettings").then((s) => {
  $("client-id").value = s.clientId;
  $("client-secret").value = s.clientSecret;
  $("test-port").value = s.testPort;
  if (!s.clientId) showSettings(true);
});

// Settings open from the cog in the header, as in foxmate.
function showSettings(open) {
  $("settings-box").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
}
$("settings-toggle").addEventListener("click", () => showSettings($("settings-box").hidden));
call("redirect").then((uri) => ($("redirect").textContent = uri));
call("status").then((s) => show("status", statusText(s)), () => {});
