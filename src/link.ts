import { memoryStore, type Store } from "foxgate";
import type { Vault } from "foxvault";
import { FoxlinkError, safeCode } from "./errors.js";
import { loopbackRedirectUrl, type Provider } from "./provider.js";

/** The parts of `browser.identity` that foxlink uses. */
export interface IdentityLike {
  getRedirectURL(): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string>;
}

export interface LinkOptions {
  provider: Provider;
  /** A foxvault vault. It keeps the access token and the refresh token. */
  vault: Vault;
  /** Where the token record (scopes and expiry, no tokens) lives. Default: memoryStore(). */
  store?: Store;
  /** `browser.identity` in Firefox. */
  identity?: IdentityLike;
  /** The redirect URI. Default: from `identity` and `provider.redirect`. */
  redirectUri?: string;
  /** Opens the authorize URL and returns the redirect URL. Default: `identity.launchWebAuthFlow`. */
  launch?: (details: { url: string; interactive: boolean }) => Promise<string>;
  /** `inject`: foxvault adds the header in Firefox (attachHeaderInjection). `use`: foxlink adds it in host code. Default: `use`. */
  transport?: "use" | "inject";
  fetch?: typeof fetch;
  /** The clock, in ms since 1970. Default: Date.now. */
  now?: () => number;
  /** Refresh this long before the access token expires. Default: 60 seconds. */
  skewMs?: number;
}

export interface LinkStatus {
  connected: boolean;
  scopes: string[];
  /** When the access token expires, in ms since 1970, by the local clock. */
  expiresAt?: number;
  /** False when the provider sent no refresh token. Then the user must connect again when the access token expires. */
  refreshable?: boolean;
}

interface TokenRecord {
  scopes: string[];
  expiresAt: number;
  refreshable: boolean;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** Keep expires_in between 60 seconds and 1 day. A missing or bad value counts as 300 seconds. */
const lifetimeMs = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return (Number.isFinite(n) ? Math.min(Math.max(n, 60), 86_400) : 300) * 1000;
};

/** A form POST result. `status` 0 means a network error. */
interface FormResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

function tokenResult(result: FormResult): TokenResponse {
  if (!result.ok) {
    const oauthError = safeCode(result.body.error);
    throw new FoxlinkError("token-error", `The token endpoint refused${oauthError ? ` with ${oauthError}` : ""} (HTTP ${result.status}).`, { status: result.status, oauthError });
  }
  const token = result.body.access_token;
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) throw new FoxlinkError("token-error", "The token endpoint sent no usable access token.");
  return result.body as unknown as TokenResponse;
}

const idTokenFail = () => new FoxlinkError("id-token", "The ID token does not match this sign-in.");

export function createLink(options: LinkOptions) {
  const { provider, vault } = options;
  const store = options.store ?? memoryStore();
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const transport = options.transport ?? "use";
  if (transport !== "use" && transport !== "inject") throw new FoxlinkError("bad-config", "transport must be use or inject.");
  const key = `foxlink:${provider.id}`;
  const handles = { access: `vault:flk-${provider.id}-access`, refresh: `vault:flk-${provider.id}-refresh` };
  const tokenHosts = [...new Set([provider.tokenUrl, provider.revokeUrl ?? provider.tokenUrl].map((u) => new URL(u).hostname))];
  let connecting = false;
  let refreshing: Promise<void> | undefined;
  /** Goes up by one with each new access token, so two 401s for one token send one refresh. */
  let generation = 0;

  const redirectUri = () => {
    if (options.redirectUri) return options.redirectUri;
    if (!options.identity) throw new FoxlinkError("bad-config", "Pass identity (browser.identity) or redirectUri.");
    const url = options.identity.getRedirectURL();
    return provider.redirect === "loopback" ? loopbackRedirectUrl(url) : url;
  };

  const readRecord = async (): Promise<TokenRecord | undefined> => {
    const value = (await store.get(key)) as TokenRecord | undefined;
    return value && typeof value === "object" && Array.isArray(value.scopes) && typeof value.expiresAt === "number" ? value : undefined;
  };

  /** POST a form. It never throws, so it can run inside vault.use. */
  async function postForm(url: string, params: Record<string, string>, asClient = true): Promise<FormResult> {
    const body = new URLSearchParams(asClient ? { client_id: provider.clientId, ...params } : params);
    if (asClient && provider.clientSecret) body.set("client_secret", provider.clientSecret);
    try {
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
      const parsed: unknown = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} };
    } catch {
      return { ok: false, status: 0, body: {} };
    }
  }

  /** Revoke a token that foxlink will not keep. Errors are ignored: the token is dropped either way. */
  async function revokeQuietly(token: string | undefined) {
    if (provider.revokeUrl && token) await postForm(provider.revokeUrl, { token }, false);
  }

  async function save(tokens: TokenResponse, scopes: string[], replaceRefresh: boolean) {
    await vault.remove(handles.access);
    await vault.set(handles.access, tokens.access_token, { domains: provider.apiHosts });
    if (transport === "inject") {
      await vault.injectHeader({ handle: handles.access, header: "Authorization", hosts: provider.apiHosts, format: "Bearer {secret}", allowHttp: provider.allowHttp });
    }
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token.length >= 8) {
      await vault.remove(handles.refresh);
      await vault.set(handles.refresh, tokens.refresh_token, { domains: tokenHosts });
    } else if (replaceRefresh) {
      await vault.remove(handles.refresh);
    }
    const refreshable = (await vault.list()).some((s) => s.handle === handles.refresh);
    const record: TokenRecord = { scopes, expiresAt: now() + lifetimeMs(tokens.expires_in), refreshable };
    await store.set(key, record);
    return record;
  }

  function checkIdToken(idToken: unknown, nonce: string) {
    const payload = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    } catch {
      throw idTokenFail();
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.nonce !== nonce || !aud.includes(provider.clientId)) throw idTokenFail();
    if (provider.issuers.length && !provider.issuers.includes(String(claims.iss))) throw idTokenFail();
  }

  async function connect(request: { scopes?: string[]; interactive?: boolean } = {}): Promise<LinkStatus> {
    if (connecting) throw new FoxlinkError("busy", "A connect is already running.");
    connecting = true;
    try {
      const scopes = [...new Set(request.scopes ?? provider.scopes)];
      if (scopes.length === 0 || !scopes.every((s) => provider.allowedScopes.includes(s))) {
        throw new FoxlinkError("bad-scope", "Ask only for scopes that the provider config allows.");
      }
      const redirect = redirectUri();
      const verifier = random(32);
      const state = random(24);
      const nonce = scopes.includes("openid") ? random(24) : undefined;
      const url = new URL(provider.authorizeUrl);
      const params: Record<string, string> = {
        ...provider.authParams,
        client_id: provider.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: scopes.join(" "),
        state,
        code_challenge: await sha256(verifier),
        code_challenge_method: "S256",
        ...(nonce ? { nonce } : {}),
      };
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

      const launch = options.launch ?? options.identity?.launchWebAuthFlow.bind(options.identity);
      if (!launch) throw new FoxlinkError("bad-config", "Pass identity (browser.identity) or launch.");
      let back: URL;
      try {
        back = new URL(await launch({ url: url.href, interactive: request.interactive ?? true }));
      } catch {
        throw new FoxlinkError("authorize-failed", "The sign-in window failed or was closed.");
      }
      const expected = new URL(redirect);
      if (back.origin !== expected.origin || back.pathname !== expected.pathname) throw new FoxlinkError("redirect-mismatch", "The sign-in returned to a URL that is not the redirect URI.");
      if (back.searchParams.get("state") !== state) throw new FoxlinkError("state-mismatch", "The sign-in state does not match. Try to connect again.");
      const error = back.searchParams.get("error");
      if (error === "access_denied") throw new FoxlinkError("access-denied", "The user did not allow access.");
      const code = back.searchParams.get("code");
      if (error || !code) {
        const oauthError = safeCode(error);
        throw new FoxlinkError("authorize-failed", `The sign-in failed${oauthError ? ` with ${oauthError}` : ""}.`, { oauthError });
      }

      const tokens = tokenResult(await postForm(provider.tokenUrl, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }));
      const granted = typeof tokens.scope === "string" ? tokens.scope.split(" ").filter(Boolean) : scopes;
      try {
        if (granted.some((s) => !scopes.includes(s))) throw new FoxlinkError("scope-creep", "The provider granted more scopes than foxlink asked for.");
        if (nonce) checkIdToken(tokens.id_token, nonce);
      } catch (refused) {
        await revokeQuietly(tokens.refresh_token ?? tokens.access_token);
        throw refused;
      }
      await save(tokens, granted, true);
      return await status();
    } finally {
      connecting = false;
    }
  }

  async function forget() {
    await vault.remove(handles.access);
    await vault.remove(handles.refresh);
    await store.set(key, null);
    generation += 1;
  }

  async function doRefresh() {
    const record = await readRecord();
    if (!record) throw new FoxlinkError("not-connected", "Connect first.");
    if (!record.refreshable) {
      await forget();
      throw new FoxlinkError("reconnect", "The access token expired and there is no refresh token. Connect again.");
    }
    const result = await vault.use(handles.refresh, (token) => postForm(provider.tokenUrl, { grant_type: "refresh_token", refresh_token: token }));
    if (result.status >= 400 && result.status < 500 && safeCode(result.body.error) === "invalid_grant") {
      await forget();
      throw new FoxlinkError("reconnect", "The provider refused the refresh token. Connect again.", { status: result.status, oauthError: "invalid_grant" });
    }
    const tokens = tokenResult(result);
    // A refresh cannot add scopes. Keep the ones that both lists hold.
    const granted = typeof tokens.scope === "string" ? tokens.scope.split(" ").filter((s) => record.scopes.includes(s)) : record.scopes;
    await save(tokens, granted, false);
    generation += 1;
  }

  /** Refresh the access token. Calls at the same time share one request. */
  function refresh(): Promise<void> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function sendOnce(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    if (transport === "inject") return doFetch(url.href, { ...init, headers });
    const out = await vault.use(handles.access, async (token) => {
      headers.set("authorization", `Bearer ${token}`);
      try {
        return { response: await doFetch(url.href, { ...init, headers }) };
      } catch {
        return { response: undefined };
      }
    });
    if (!out.response) throw new FoxlinkError("http-error", `The request to ${url.hostname} failed.`, { status: 0 });
    return out.response;
  }

  async function send(url: URL, init: RequestInit) {
    if (refreshing) await refreshing;
    return sendOnce(url, init);
  }

  /** fetch for the API hosts, with the access token. It refreshes on expiry and one time on 401. */
  async function authorizedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw new FoxlinkError("bad-host", "Not a URL.");
    }
    const httpOk = url.protocol === "https:" || (provider.allowHttp && url.protocol === "http:");
    if (!httpOk || !provider.apiHosts.includes(url.hostname)) throw new FoxlinkError("bad-host", `${url.hostname} is not an API host of this provider.`);
    const record = await readRecord();
    if (!record) throw new FoxlinkError("not-connected", "Connect first.");
    if (now() >= record.expiresAt - (options.skewMs ?? 60_000)) await refresh();
    const seen = generation;
    const first = await send(url, init);
    if (first.status !== 401) return first;
    if (seen === generation) await refresh();
    const second = await send(url, init);
    if (second.status === 401) throw new FoxlinkError("unauthorized", "The provider refused the new access token.", { status: 401 });
    return second;
  }

  /** Revoke the grant at the provider, then forget every token. It forgets them also when the revoke fails. */
  async function disconnect(): Promise<{ revoked: boolean }> {
    let revoked = false;
    const held = new Set((await vault.list()).map((s) => s.handle));
    const handle = held.has(handles.refresh) ? handles.refresh : held.has(handles.access) ? handles.access : undefined;
    if (provider.revokeUrl && handle) {
      const revokeUrl = provider.revokeUrl;
      revoked = (await vault.use(handle, (token) => postForm(revokeUrl, { token }, false))).ok;
    }
    await forget();
    return { revoked };
  }

  async function status(): Promise<LinkStatus> {
    const record = await readRecord();
    if (!record) return { connected: false, scopes: [] };
    return { connected: true, scopes: [...record.scopes], expiresAt: record.expiresAt, refreshable: record.refreshable };
  }

  return Object.freeze({
    connect,
    status,
    fetch: authorizedFetch,
    disconnect,
    /** True when the user granted this scope. */
    hasScope: async (scope: string) => Boolean((await readRecord())?.scopes.includes(scope)),
    /** The redirect URI to register with the provider. */
    redirectUri,
  });
}

export type Link = ReturnType<typeof createLink>;
