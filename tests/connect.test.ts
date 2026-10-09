// Failure modes O1-O13 in docs/failure-modes.md: the OAuth connect flow.
import { describe, expect, it } from "vitest";
import { nodeAuthFlow } from "../e2e/fake-google.mjs";
import { REDIRECT, SCOPE, leaks, rejects, setup } from "./helpers.js";

/** A launch that answers with a URL built from the state that foxlink sent. */
const answer = (build: (state: string) => string) => async ({ url }: { url: string }) => build(new URL(url).searchParams.get("state") ?? "");

describe("connect", () => {
  it("connects with the default read-only scopes and stores no token in plain text", async () => {
    const { g, link, store, vault } = await setup();
    const status = await link.connect();
    expect(status).toMatchObject({ connected: true, refreshable: true, scopes: [SCOPE.gmailRead, SCOPE.calRead] });
    expect((await vault.list()).map((s) => s.handle).toSorted()).toEqual(["vault:flk-google-access", "vault:flk-google-refresh"]);
    expect(leaks(store.dump(), g.issued)).toEqual([]);
  });

  it("O1: refuses a changed state", async () => {
    const { g, link, store } = await setup();
    g.behavior.state = "change";
    await rejects(() => link.connect(), "state-mismatch");
    expect(g.counts.token).toBe(0);
    expect((await link.status()).connected).toBe(false);
    expect(store.keys().filter((k) => k.startsWith("foxlink:"))).toEqual([]);
  });

  it("O2: refuses a missing state", async () => {
    const { g, link } = await setup();
    g.behavior.state = "drop";
    await rejects(() => link.connect(), "state-mismatch");
    expect(g.counts.token).toBe(0);
  });

  it("O3: refuses a URL that is not the redirect URI", async () => {
    const { g, link } = await setup({ link: { launch: answer((s) => `https://evil.example/mozoauth2/0123456789abcdef?code=x&state=${s}`) } });
    await rejects(() => link.connect(), "redirect-mismatch");
    const lookalike = await setup({ link: { launch: answer((s) => `${REDIRECT}.evil.example/?code=x&state=${s}`) } });
    await rejects(() => lookalike.link.connect(), "redirect-mismatch");
    expect(g.counts.token + lookalike.g.counts.token).toBe(0);
  });

  it("O4, O7: sends an S256 challenge, the same redirect URI, and the matching verifier", async () => {
    const { link, launches } = await setup();
    await link.connect();
    const params = new URL(launches[0] ?? "").searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(params.get("response_type")).toBe("code");
    expect((params.get("state") ?? "").length).toBeGreaterThanOrEqual(22);
    // The fake token endpoint refuses a missing or wrong verifier, so a working connect proves the match.
    expect((await link.status()).connected).toBe(true);
  });

  it("O5: a second connect at the same time throws busy", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const { link } = await setup({
      link: {
        launch: async (details) => {
          await gate;
          return nodeAuthFlow(details);
        },
      },
    });
    const first = link.connect();
    await rejects(() => link.connect(), "busy");
    release?.();
    expect((await first).connected).toBe(true);
  });

  it("O6: a redirect URI that the client does not have fails before any token", async () => {
    const { g, link } = await setup({ link: { redirectUri: "http://127.0.0.1/mozoauth2/ffffffffffffffff" } });
    await rejects(() => link.connect(), "authorize-failed");
    expect(g.counts.token).toBe(0);
    expect((await link.status()).connected).toBe(false);
  });

  it("O8: the user denies consent", async () => {
    const { g, link, vault } = await setup();
    g.behavior.consent = "deny";
    await rejects(() => link.connect(), "access-denied");
    expect(await vault.list()).toEqual([]);
  });

  it("O9: an error text from the server does not reach the message", async () => {
    const evil = '<img src=x onerror="alert(1)">'.repeat(20);
    const { link } = await setup({ link: { launch: answer((s) => `${REDIRECT}?state=${s}&error=${encodeURIComponent(evil)}&error_description=${encodeURIComponent(evil)}`) } });
    const error = await rejects(() => link.connect(), "authorize-failed");
    expect(error.message).not.toMatch(/[<>"=]/);
    expect(error.message.length).toBeLessThan(160);
  });

  it("O10: more scopes than asked for: revoke and store nothing", async () => {
    const { g, link, vault } = await setup();
    g.behavior.extraScope = "https://mail.google.com/";
    await rejects(() => link.connect(), "scope-creep");
    expect(g.counts.revoke).toBe(1);
    expect(await vault.list()).toEqual([]);
    expect((await link.status()).connected).toBe(false);
  });

  it("O11: a scope outside the config throws before any window opens", async () => {
    const { link, launches } = await setup();
    await rejects(() => link.connect({ scopes: [SCOPE.gmailSend] }), "bad-scope");
    expect(launches).toEqual([]);
  });

  it("O11: a scope that the config allows can be asked for", async () => {
    const { link } = await setup({ provider: { allowedScopes: [SCOPE.gmailRead, SCOPE.calRead, SCOPE.gmailSend] } });
    expect((await link.connect({ scopes: [SCOPE.gmailRead, SCOPE.gmailSend] })).scopes).toEqual([SCOPE.gmailRead, SCOPE.gmailSend]);
  });

  it("O12: a partial grant connects with the granted scopes only", async () => {
    const { g, link } = await setup();
    g.behavior.grantOnly = [SCOPE.gmailRead];
    expect((await link.connect()).scopes).toEqual([SCOPE.gmailRead]);
    expect(await link.hasScope(SCOPE.calRead)).toBe(false);
    expect(await link.hasScope(SCOPE.gmailRead)).toBe(true);
  });

  it("O13: an ID token with another nonce or audience is refused", async () => {
    const scopes = ["openid", SCOPE.gmailRead];
    const ok = await setup({ provider: { scopes } });
    expect((await ok.link.connect()).connected).toBe(true);
    for (const claims of [{ nonce: "attacker-nonce" }, { aud: "other-client" }]) {
      const { g, link, vault, launches } = await setup({ provider: { scopes } });
      g.behavior.idToken = claims;
      await rejects(() => link.connect(), "id-token");
      expect(new URL(launches[0] ?? "").searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{22,}$/);
      expect(g.counts.revoke).toBe(1);
      expect(await vault.list()).toEqual([]);
    }
  });
});
