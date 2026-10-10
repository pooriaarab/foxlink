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
  $(id).dataset.runs = String(Number($(id).dataset.runs ?? 0) + 1);
}

const statusText = (s) => (s.connected ? `Connected (${s.scopes.map((x) => x.split("/").pop()).join(", ")})` : "Not connected");
const message = async () => ({
  ...Object.fromEntries(["to", "cc", "bcc", "subject", "body"].map((id) => [id, $(id).value])),
  attachments: await Promise.all([...$("files").files].map(async (f) => ({ filename: f.name, mimeType: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) }))),
});

const shown = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? `${x.filename} (${x.mimeType}, ${x.size} bytes, SHA-256 ${x.sha256})` : x)).join(", ") || "(none)" : String(v));
const ORDER = ["to", "cc", "bcc", "subject", "body", "attachments", "privateData"];
const rank = (key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
function approval(args) {
  const rows = document.createElement("dl");
  for (const [k, v] of Object.entries(args).toSorted(([a], [b]) => rank(a) - rank(b))) rows.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: shown(v) }));
  $("pending").replaceChildren(Object.assign(document.createElement("p"), { textContent: "Approve this exact action?" }), rows);
}
const outcome = (r) => (r.status === "sent" ? "Sent" : `${r.status}${r.reason ? `: ${r.reason}` : ""}`);

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
  send: async () => {
    const r = await call("send", { message: await message() });
    if (r.status === "ask") {
      waiting = { requestId: r.requestId };
      approval(r.args);
      $("approve").hidden = $("deny").hidden = false;
    }
    show("result", r.status === "ask" ? "Waiting for approval" : outcome(r));
  },
  approve: async () => {
    const { token } = await call("approve", waiting);
    $("approve").hidden = $("deny").hidden = true;
    show("result", outcome(await call("send", { message: await message(), token })));
  },
  deny: async () => {
    await call("deny", waiting);
    $("approve").hidden = $("deny").hidden = true;
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
  if (!s.clientId) $("settings-box").open = true;
});
call("redirect").then((uri) => ($("redirect").textContent = uri));
call("status").then((s) => show("status", statusText(s)), () => {});
