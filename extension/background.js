// The demo background (an MV3 event page). It runs foxlink with the real
// browser.identity, storage.local, and foxvault header injection, so the
// popup never holds a token. Send asks foxgate first, and the popup shows
// the exact message for approval.
import { createFoxgate, storageAreaStore } from "foxgate";
import { attachHeaderInjection, createVault, indexedDbKeyStore } from "foxvault";
import { FOXLINK_TOOLS, GOOGLE_SCOPES, calendar, createLink, gmail, googleProvider, loopbackRedirectUrl } from "../src/index.ts";

const store = storageAreaStore(browser.storage.local);
const { gate, host } = createFoxgate({ tools: FOXLINK_TOOLS, store });
const vault = createVault({ store, keyStore: indexedDbKeyStore() });
// At the top level, so Firefox wakes this page for the first API request too.
attachHeaderInjection(vault, browser);

async function settings() {
  const { settings: saved } = await browser.storage.local.get("settings");
  return { clientId: "", clientSecret: "", testPort: "", allowSend: false, ...saved };
}

let vaultReady;
let current;

// The test port points every endpoint at the local fake Google that e2e/run.mjs starts.
async function build(s) {
  const read = [GOOGLE_SCOPES.gmailRead, GOOGLE_SCOPES.calendarRead];
  const scopes = s.allowSend ? [...read, GOOGLE_SCOPES.gmailSend] : read;
  const local = (sub) => `http://${sub}.localhost:${Number(s.testPort)}`;
  const endpoints = s.testPort
    ? { authorizeUrl: `${local("accounts")}/o/oauth2/v2/auth`, tokenUrl: `${local("oauth2")}/token`, revokeUrl: `${local("oauth2")}/revoke`, gmailBase: `${local("gmail")}/gmail/v1`, calendarBase: `${local("www")}/calendar/v3` }
    : undefined;
  const provider = googleProvider({ clientId: s.clientId, ...(s.clientSecret ? { clientSecret: s.clientSecret } : {}), scopes, endpoints, allowHttp: Boolean(s.testPort) });
  vaultReady ??= vault.status().then((state) => (state === "new" ? vault.initialize() : undefined));
  await vaultReady;
  const link = createLink({ provider, vault, store, identity: browser.identity, transport: "inject" });
  if (!(await host.grants()).some((g) => g.scope === "submit")) await host.addGrant({ scope: "submit", domains: provider.apiHosts });
  return { link, mail: gmail(link, { gate }), cal: calendar(link, { gate }) };
}

// One link for each settings value, so calls at the same time share one refresh and one connect.
async function setup() {
  const s = await settings();
  if (!s.clientId) throw new Error("Type your OAuth client ID first.");
  const key = JSON.stringify(s);
  if (current?.key !== key) current = { key, ready: build(s) };
  return current.ready;
}

const handlers = {
  getSettings: settings,
  saveSettings: async ({ value }) => {
    await browser.storage.local.set({ settings: { ...(await settings()), ...value } });
    return settings();
  },
  redirect: async () => loopbackRedirectUrl(browser.identity.getRedirectURL()),
  status: async () => (await setup()).link.status(),
  connect: async () => (await setup()).link.connect(),
  disconnect: async () => (await setup()).link.disconnect(),
  events: async () => (await (await setup()).cal.listEvents({ max: 3 })).events.map((e) => ({ summary: e.summary, start: e.start })),
  subjects: async () => (await (await setup()).mail.listMessages({ max: 5 })).messages.map((m) => ({ id: m.id, subject: m.subject, from: m.from })),
  read: async ({ id }) => {
    const m = await (await setup()).mail.getMessage(id);
    return { subject: m.subject, text: m.text.slice(0, 600) };
  },
  send: async ({ message }) => {
    const result = await (await setup()).mail.sendMessage(message);
    if (result.status !== "ask") return result;
    const request = (await host.pending()).find((r) => r.id === result.requestId);
    return { ...result, text: request?.text ?? "" };
  },
  approve: async ({ requestId, message }) => {
    const token = await host.approve(requestId);
    return (await setup()).mail.sendMessage(message, { token });
  },
  deny: async ({ requestId }) => {
    await host.reject(requestId);
    return { status: "rejected" };
  },
};

// Answers carry only names, subjects, short text, and statuses. No token goes to the popup.
browser.runtime.onMessage.addListener(async (message) => {
  const handler = handlers[message?.type];
  if (!handler) return { error: "unknown message" };
  try {
    return { ok: await handler(message) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), code: error?.code };
  }
});
