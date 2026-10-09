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
const message = () => ({ to: $("to").value, subject: $("subject").value, body: $("body").value });

function list(items) {
  $("list").replaceChildren(...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
  show("result", `${items.length} shown`);
}

const actions = {
  save: async () => {
    const value = { clientId: $("client-id").value.trim(), clientSecret: $("client-secret").value, testPort: $("test-port").value.trim(), allowSend: $("allow-send").checked };
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
    const r = await call("send", { message: message() });
    if (r.status === "ask") {
      waiting = { requestId: r.requestId, message: message() };
      $("pending").textContent = `Approve this exact action?\n${r.text}`;
      $("approve").hidden = $("deny").hidden = false;
    }
    show("result", r.status === "ask" ? "Waiting for approval" : `${r.status}${r.reason ? `: ${r.reason}` : ""}`);
  },
  approve: async () => {
    const r = await call("approve", waiting);
    $("approve").hidden = $("deny").hidden = true;
    show("result", r.status === "sent" ? "Sent" : `${r.status}${r.reason ? `: ${r.reason}` : ""}`);
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

call("getSettings").then((s) => {
  $("client-id").value = s.clientId;
  $("client-secret").value = s.clientSecret;
  $("test-port").value = s.testPort;
  $("allow-send").checked = s.allowSend;
  if (!s.clientId) $("settings-box").open = true;
});
call("redirect").then((uri) => ($("redirect").textContent = uri));
call("status").then((s) => show("status", statusText(s)), () => {});
