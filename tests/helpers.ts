// Shared setup: a fake Google, a foxvault vault, a foxgate store, and a link
// that runs the OAuth flow in Node with nodeAuthFlow.
import { createVault } from "foxvault";
import { afterEach } from "vitest";
import { nodeAuthFlow, startFakeGoogle } from "../e2e/fake-google.mjs";
import { createLink, googleProvider, type LinkOptions, type ProviderOptions } from "../src/index.js";

export const CLIENT_ID = "client-1.apps.googleusercontent.com";
export const REDIRECT = "http://127.0.0.1/mozoauth2/0123456789abcdef";
export const SCOPE = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  calRead: "https://www.googleapis.com/auth/calendar.readonly",
  calWrite: "https://www.googleapis.com/auth/calendar.events",
};

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

export async function setup(options: { provider?: Partial<ProviderOptions>; link?: Partial<LinkOptions> } = {}) {
  const g = await startFakeGoogle();
  open.push(g);
  g.addClient({ id: CLIENT_ID, redirectUris: [REDIRECT] });
  const store = recordingStore();
  const vault = createVault({ store });
  await vault.initialize();
  const launches: string[] = [];
  const provider = googleProvider({ clientId: CLIENT_ID, endpoints: g.endpoints, allowHttp: true, ...options.provider });
  const link = createLink({
    provider,
    vault,
    store,
    redirectUri: REDIRECT,
    launch: async (details) => {
      launches.push(details.url);
      return nodeAuthFlow(details);
    },
    ...options.link,
  });
  return { g, vault, store, link, provider, launches };
}

/** A store in memory that can show all it holds, for leak scans. */
export function recordingStore() {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(data.get(key)),
    set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    keys: () => [...data.keys()],
    dump: () => JSON.stringify([...data]),
  };
}

/** True when the text holds any of the values. */
export const leaks = (text: string, values: string[]) => values.filter((v) => text.includes(v));

/** Expect fn to reject with a FoxlinkError (or VaultError) code, and return the error. */
export async function rejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    if ((error as { code?: string }).code !== code) throw new Error(`Expected code ${code}, got ${String((error as { code?: string }).code)}: ${String(error)}`, { cause: error });
    return error as Error & { code: string };
  }
  throw new Error(`Expected code ${code}, but it did not throw`);
}
