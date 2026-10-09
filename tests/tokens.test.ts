// Failure modes T1-T13, L1-L4, and O15 in docs/failure-modes.md: tokens.
import { createVault } from "foxvault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeAuthFlow } from "../e2e/fake-google.mjs";
import { createLink, googleProvider } from "../src/index.js";
import { CLIENT_ID, REDIRECT, leaks, recordingStore, rejects, setup } from "./helpers.js";

const HOUR = 3_600_000;
const always401: typeof fetch = async (input, init) => (String(input).includes("/gmail/") ? new Response("{}", { status: 401 }) : fetch(input, init));

/** A link with a clock that the test moves. */
async function clocked(options: Parameters<typeof setup>[0] = {}) {
  const clock = { t: Date.parse("2026-10-09T10:00:00Z") };
  const env = await setup({ ...options, link: { now: () => clock.t, ...options.link } });
  const list = () => env.link.fetch(`${env.g.endpoints.gmailBase}/users/me/messages?maxResults=1`);
  const refreshToken = () => env.g.issued.filter((v: string) => v.startsWith("1//")).at(-1) ?? "";
  return { ...env, clock, list, refreshToken };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokens", () => {
  it("T1: an access token that expired by the local clock is refreshed one time", async () => {
    const { g, link, clock, list } = await clocked();
    await link.connect();
    clock.t += HOUR;
    expect((await list()).status).toBe(200);
    expect((await list()).status).toBe(200);
    expect(g.counts.refresh).toBe(1);
  });

  it("T2: a 401 with a fresh local token refreshes one time and retries one time", async () => {
    const { g, link, list } = await clocked();
    await link.connect();
    g.expireAccessTokens();
    expect((await list()).status).toBe(200);
    expect(g.counts.refresh).toBe(1);

    const stuck = await clocked({ link: { fetch: always401 } });
    await stuck.link.connect();
    await rejects(() => stuck.list(), "unauthorized");
    expect(stuck.g.counts.refresh).toBe(1);
  });

  it("T3: a token that expires within 60 seconds is refreshed first", async () => {
    const { g, link, clock, list } = await clocked();
    await link.connect();
    clock.t += HOUR - 30_000;
    await list();
    expect(g.counts.refresh).toBe(1);
  });

  it("T4: expires_in is kept between 60 seconds and 1 day", async () => {
    for (const [value, seconds] of [[undefined, 300], [0, 60], [-5, 60], ["abc", 300], [1e9, 86_400], [3599, 3599]] as const) {
      const { g, link, clock } = await clocked();
      g.behavior.expiresIn = value;
      const status = await link.connect();
      expect(status.expiresAt).toBe(clock.t + seconds * 1000);
    }
  });

  it("T5: five calls with an expired token send one refresh", async () => {
    const { g, link, clock, list } = await clocked();
    await link.connect();
    g.behavior.tokenDelayMs = 50;
    clock.t += HOUR;
    const results = await Promise.all([list(), list(), list(), list(), list()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(g.counts.refresh).toBe(1);
  });

  it("T6: two calls that both get 401 send one refresh", async () => {
    const { g, link, list } = await clocked();
    await link.connect();
    g.behavior.tokenDelayMs = 50;
    g.expireAccessTokens();
    const results = await Promise.all([list(), list()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(g.counts.refresh).toBe(1);

    // The second 401 comes back after the first refresh is done. It must not refresh again.
    let calls = 0;
    const slowSecond: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).includes("/gmail/") && ++calls === 2) await new Promise((done) => setTimeout(done, 200));
      return res;
    };
    const late = await clocked({ link: { fetch: slowSecond } });
    await late.link.connect();
    late.g.expireAccessTokens();
    expect((await Promise.all([late.list(), late.list()])).map((r) => r.status)).toEqual([200, 200]);
    expect(late.g.counts.refresh).toBe(1);
  });

  it("T7: a revoked refresh token forgets the tokens and asks to reconnect", async () => {
    const { g, link, vault, clock, list, refreshToken } = await clocked();
    await link.connect();
    await fetch(g.endpoints.revokeUrl, { method: "POST", body: new URLSearchParams({ token: refreshToken() }) });
    clock.t += HOUR;
    await rejects(() => list(), "reconnect");
    expect((await link.status()).connected).toBe(false);
    expect(await vault.list()).toEqual([]);
    await rejects(() => list(), "not-connected");
  });

  it("O15: no refresh token: connect works, then expiry asks to reconnect", async () => {
    const { g, link, clock, list } = await clocked();
    g.behavior.noRefreshToken = true;
    expect(await link.connect()).toMatchObject({ connected: true, refreshable: false });
    expect((await list()).status).toBe(200);
    clock.t += HOUR;
    await rejects(() => list(), "reconnect");
    expect(g.counts.refresh).toBe(0);
  });

  it("T8: a token endpoint that is down keeps the tokens", async () => {
    const { g, link, clock, list } = await clocked();
    await link.connect();
    g.behavior.tokenStatus = 503;
    clock.t += HOUR;
    const error = await rejects(() => list(), "token-error");
    expect((error as { status?: number }).status).toBe(503);
    expect((await link.status()).connected).toBe(true);
    g.behavior.tokenStatus = 200;
    expect((await list()).status).toBe(200);
  });

  it("T9: a new refresh token from the server is stored and used", async () => {
    const { g, link, clock, list, refreshToken } = await clocked();
    await link.connect();
    const first = refreshToken();
    g.behavior.rotateRefresh = true;
    clock.t += HOUR;
    await list();
    expect(refreshToken()).not.toBe(first);
    expect(g.refreshTokenWorks(first)).toBe(false);
    clock.t += HOUR;
    expect((await list()).status).toBe(200);
    expect(g.counts.refresh).toBe(2);
  });

  it("T10: disconnect revokes, and forgets even when revoke fails", async () => {
    const ok = await clocked();
    await ok.link.connect();
    const token = ok.refreshToken();
    expect(await ok.link.disconnect()).toEqual({ revoked: true });
    expect(ok.g.refreshTokenWorks(token)).toBe(false);
    expect(await ok.vault.list()).toEqual([]);

    const down = await clocked();
    await down.link.connect();
    down.g.behavior.revokeStatus = 503;
    expect(await down.link.disconnect()).toEqual({ revoked: false });
    expect(await down.vault.list()).toEqual([]);
    expect((await down.link.status()).connected).toBe(false);
  });

  it("T11: a call before connect or after disconnect sends nothing", async () => {
    const { g, link, list } = await clocked();
    await rejects(() => list(), "not-connected");
    await link.connect();
    await link.disconnect();
    await rejects(() => list(), "not-connected");
    expect(g.log.filter((r: { host: string }) => r.host === "gmail")).toEqual([]);
  });

  it("T12: a host that is not an API host gets no token", async () => {
    const { g, link } = await clocked();
    await link.connect();
    await rejects(() => link.fetch(`${g.origin("evil")}/steal`), "bad-host");
    await rejects(() => link.fetch(`${g.endpoints.tokenUrl}`), "bad-host");
    await rejects(() => link.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages"), "bad-host");
    expect(g.log.filter((r: { token: string | null }) => r.token)).toEqual([]);
  });

  it("T13: a locked vault stops the call before any request", async () => {
    const { g } = await clocked();
    const store = recordingStore();
    const vault = createVault({ store });
    await vault.initialize({ passphrase: "correct horse battery staple" });
    const provider = googleProvider({ clientId: CLIENT_ID, endpoints: g.endpoints, allowHttp: true });
    const link = createLink({ provider, vault, store, redirectUri: REDIRECT, launch: nodeAuthFlow });
    await link.connect();
    vault.lock();
    const before = g.log.length;
    await rejects(() => link.fetch(`${g.endpoints.gmailBase}/users/me/messages`), "locked");
    expect(g.log.length).toBe(before);
  });

  it("L1-L4: no token in errors, the store, results, or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { g, link, store, clock, list } = await clocked();
    const errors: unknown[] = [];
    const keep = (p: Promise<unknown>) => p.catch((e: unknown) => errors.push(e));
    await link.connect();
    g.behavior.rotateRefresh = true;
    clock.t += HOUR;
    await list();
    await keep(link.fetch(`${g.origin("evil")}/x`));
    g.behavior.tokenStatus = 400;
    clock.t += HOUR;
    await keep(list());
    g.behavior.tokenStatus = 200;
    g.behavior.state = "change";
    await keep(link.connect());
    const text = errors.map((e) => `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ""}`).join("\n");
    expect(errors).toHaveLength(3);
    expect(leaks(text, g.issued)).toEqual([]);
    expect(leaks(store.dump(), g.issued)).toEqual([]);
    expect(leaks(JSON.stringify(await link.status()), g.issued)).toEqual([]);
    await link.disconnect();
    expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
  });
});
