// A fake Google for tests: the OAuth authorize page, the token endpoint with
// PKCE checks, refresh, revoke, and the Gmail and Calendar REST shapes that
// foxlink uses. It routes by the first label of the host name, as Google does:
// accounts.localhost, oauth2.localhost, gmail.localhost, www.localhost.
// It listens on "::" so that 127.0.0.1 and ::1 both reach it.
//
//   const g = await startFakeGoogle();
//   g.addClient({ id: "client-1", redirectUris: ["http://127.0.0.1/mozoauth2/abc"] });
//   g.endpoints.authorizeUrl   // http://accounts.localhost:<port>/o/oauth2/v2/auth
//
// `g.behavior` changes how the server answers, for failure-mode tests.
// `g.log` has one entry for each request. It is test data, not a secret store.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const rand = (prefix) => prefix + randomBytes(24).toString("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (text) => createHash("sha256").update(text).digest("base64url");
const GMAIL_READ = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const GMAIL_DRAFT = ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const GMAIL_SEND = ["https://www.googleapis.com/auth/gmail.send", ...GMAIL_DRAFT];
const CAL_READ = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar"];
const CAL_WRITE = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar"];

const part = (mimeType, text) => ({ mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }], body: { size: Buffer.byteLength(text), data: b64url(text) } });

function messageResource(m, format, wanted) {
  const headers = [["From", m.from], ["To", m.to], ["Subject", m.subject], ["Date", m.date]].map(([name, value]) => ({ name, value }));
  const base = { id: m.id, threadId: m.threadId ?? m.id, labelIds: ["INBOX"], snippet: (m.text ?? m.html ?? "").replace(/<[^>]*>/g, "").slice(0, 100), internalDate: String(Date.parse(m.date)) };
  if (format === "metadata") return { ...base, payload: { mimeType: "multipart/alternative", headers: wanted.length ? headers.filter((h) => wanted.includes(h.name.toLowerCase())) : headers } };
  let payload;
  if (m.text !== undefined && m.html !== undefined) {
    const alt = { mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [part("text/plain", m.text), part("text/html", m.html)] };
    const attachment = { mimeType: "application/pdf", filename: "invoice.pdf", headers: [], body: { size: 1234, attachmentId: "att-1" } };
    payload = { mimeType: "multipart/mixed", filename: "", headers, body: { size: 0 }, parts: [alt, attachment] };
  } else {
    payload = { ...part(m.html !== undefined ? "text/html" : "text/plain", m.html ?? m.text ?? ""), headers };
  }
  return { ...base, payload, sizeEstimate: 2000 };
}

const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
};

const json = (res, status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(body));
const oauthError = (res, status, error, description) => json(res, status, { error, error_description: description });
const apiError = (res, status, reason) =>
  json(res, status, { error: { code: status, message: reason, status: status === 401 ? "UNAUTHENTICATED" : status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT" } }, status === 401 ? { "www-authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"' } : {});

export async function startFakeGoogle({ now = Date.now } = {}) {
  const clients = new Map();
  const pending = new Map(); // consent id -> authorize request
  const codes = new Map();
  const grants = new Map(); // refresh token -> grant
  const access = new Map(); // access token -> { scopes, exp, refresh, revoked }
  const messages = [];
  const events = [];
  const sent = [];
  const drafts = [];
  const invites = [];
  const writes = []; // one entry for each event insert or patch, with its sendUpdates
  const log = [];
  const issued = []; // every token, code, and secret the server gave out, for leak scans
  const counts = { token: 0, refresh: 0, revoke: 0, pixel: 0 };
  /** @type {{ consent: string, grantOnly: string[] | null, state: string, extraScope: string | null, errorDescription: string | null, expiresIn: unknown, tokenDelayMs: number, tokenStatus: number, revokeStatus: number, rotateRefresh: boolean, noRefreshToken: boolean, idToken: Record<string, unknown> }} */
  const behavior = {
    consent: "auto", // "auto" (302 at once) | "page" (consent page that goes on by itself) | "deny"
    grantOnly: null, // a list of scopes: the user unticks the others (granular consent)
    state: "echo", // "echo" | "change" | "drop"
    extraScope: null,
    errorDescription: null,
    expiresIn: 3599,
    tokenDelayMs: 0,
    tokenStatus: 200, // 503: the token endpoint is down
    revokeStatus: 200,
    rotateRefresh: false,
    noRefreshToken: false,
    idToken: {}, // overrides for ID token claims, for example { nonce: "x" }
  };

  const issueAccess = (scopes, refresh) => {
    const value = rand("ya29.fake-");
    access.set(value, { scopes, exp: now() + 3_600_000, refresh, revoked: false });
    issued.push(value);
    return value;
  };

  function authorize(url, res) {
    const p = url.searchParams;
    const client = clients.get(p.get("client_id"));
    if (!client) return res.writeHead(401, { "content-type": "text/html" }).end("<h1>Error 401: invalid_client</h1>");
    const redirectUri = p.get("redirect_uri");
    if (!client.redirectUris.includes(redirectUri)) return res.writeHead(400, { "content-type": "text/html" }).end("<h1>Error 400: redirect_uri_mismatch</h1>");
    if (p.get("response_type") !== "code" || !p.get("code_challenge") || p.get("code_challenge_method") !== "S256") {
      return res.writeHead(400, { "content-type": "text/html" }).end("<h1>Error 400: invalid_request</h1>");
    }
    const scopes = (p.get("scope") ?? "").split(" ").filter(Boolean);
    const id = rand("consent-");
    pending.set(id, { client, redirectUri, scopes, state: p.get("state"), challenge: p.get("code_challenge"), nonce: p.get("nonce") });
    if (behavior.consent === "page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Sign in - Fake Google Accounts</title><h1>foxlink test wants access</h1><ul>${scopes.map((s) => `<li>${s}</li>`).join("")}</ul><a id="allow" href="/o/oauth2/v2/approve?id=${id}">Allow</a><script>setTimeout(() => location.replace(document.getElementById("allow").href), 300)</script>`);
      return;
    }
    approve(id, res);
  }

  function approve(id, res) {
    const req = pending.get(id);
    pending.delete(id);
    if (!req) return res.writeHead(400, { "content-type": "text/html" }).end("<h1>Error 400: consent expired</h1>");
    const back = new URL(req.redirectUri);
    const state = behavior.state === "change" ? "attacker-state" : req.state;
    if (behavior.state !== "drop" && state !== null) back.searchParams.set("state", state);
    if (behavior.consent === "deny") {
      back.searchParams.set("error", "access_denied");
      if (behavior.errorDescription) back.searchParams.set("error_description", behavior.errorDescription);
    } else {
      const code = rand("4/fake-");
      const granted = behavior.grantOnly ? req.scopes.filter((s) => behavior.grantOnly.includes(s)) : req.scopes;
      codes.set(code, { ...req, granted, used: false, exp: now() + 600_000 });
      issued.push(code);
      back.searchParams.set("code", code);
      back.searchParams.set("scope", granted.join(" "));
    }
    res.writeHead(302, { location: back.href }).end();
  }

  function idToken(client, nonce) {
    const claims = { iss: "https://accounts.google.com", aud: client.id, sub: "fake-user-1", email: "me@example.com", nonce, iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 3600, ...behavior.idToken };
    return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.fake-signature`;
  }

  // The delay comes after the server made the tokens, as with a slow network on the way back.
  const slow = () => new Promise((done) => setTimeout(done, behavior.tokenDelayMs));

  async function token(req, res) {
    counts.token += 1;
    const p = new URLSearchParams(await readBody(req));
    if (behavior.tokenStatus !== 200) return oauthError(res, behavior.tokenStatus, "internal_failure", "Try again later.");
    const client = clients.get(p.get("client_id"));
    if (!client || (client.secret && p.get("client_secret") !== client.secret)) return oauthError(res, 401, "invalid_client", "Unauthorized");
    if (p.get("grant_type") === "authorization_code") {
      const code = codes.get(p.get("code") ?? "");
      if (!code || code.used || code.exp < now() || code.client !== client) return oauthError(res, 400, "invalid_grant", "Malformed auth code.");
      code.used = true;
      if (p.get("redirect_uri") !== code.redirectUri) return oauthError(res, 400, "redirect_uri_mismatch", "Bad Request");
      const verifier = p.get("code_verifier");
      if (!verifier) return oauthError(res, 400, "invalid_grant", "Missing code verifier.");
      if (sha256(verifier) !== code.challenge) return oauthError(res, 400, "invalid_grant", "Invalid code verifier.");
      const scopes = behavior.extraScope ? [...code.granted, behavior.extraScope] : code.granted;
      const refresh = behavior.noRefreshToken ? undefined : rand("1//fake-");
      if (refresh) {
        grants.set(refresh, { client, scopes, revoked: false });
        issued.push(refresh);
      }
      const body = { access_token: issueAccess(scopes, refresh), expires_in: behavior.expiresIn, scope: scopes.join(" "), token_type: "Bearer" };
      if (refresh) body.refresh_token = refresh;
      if (scopes.includes("openid")) body.id_token = idToken(client, code.nonce);
      await slow();
      return json(res, 200, body);
    }
    if (p.get("grant_type") === "refresh_token") {
      counts.refresh += 1;
      const old = p.get("refresh_token") ?? "";
      const grant = grants.get(old);
      if (!grant || grant.revoked || grant.client !== client) return oauthError(res, 400, "invalid_grant", "Token has been expired or revoked.");
      let refresh = old;
      if (behavior.rotateRefresh) {
        grant.revoked = true;
        refresh = rand("1//fake-");
        grants.set(refresh, { ...grant, revoked: false });
        issued.push(refresh);
      }
      const body = { access_token: issueAccess(grant.scopes, refresh), expires_in: behavior.expiresIn, scope: grant.scopes.join(" "), token_type: "Bearer" };
      if (refresh !== old) body.refresh_token = refresh;
      await slow();
      return json(res, 200, body);
    }
    return oauthError(res, 400, "unsupported_grant_type", "Invalid grant_type.");
  }

  async function revoke(req, res, url) {
    counts.revoke += 1;
    const value = new URLSearchParams(await readBody(req)).get("token") ?? url.searchParams.get("token") ?? "";
    if (behavior.revokeStatus !== 200) return oauthError(res, behavior.revokeStatus, "internal_failure", "Try again later.");
    const grant = grants.get(value);
    const acc = access.get(value);
    if (!grant && !acc) return oauthError(res, 400, "invalid_token", "Token expired or revoked");
    const refresh = grant ? value : acc.refresh;
    if (refresh && grants.get(refresh)) grants.get(refresh).revoked = true;
    for (const [tok, a] of access) if (tok === value || (refresh && a.refresh === refresh)) a.revoked = true;
    return json(res, 200, {});
  }

  function bearer(req, res, needed) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const a = match ? access.get(match[1]) : undefined;
    if (!a || a.revoked || a.exp <= now()) return void apiError(res, 401, "Request had invalid authentication credentials.");
    if (!a.scopes.some((s) => needed.includes(s))) return void apiError(res, 403, "Request had insufficient authentication scopes.");
    return a;
  }

  function gmail(req, res, url, body) {
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") {
      if (!bearer(req, res, GMAIL_DRAFT)) return;
      const raw = JSON.parse(body || "{}").message?.raw;
      if (typeof raw !== "string") return apiError(res, 400, "Missing draft message");
      const id = rand("r-").slice(0, 20);
      drafts.push({ id, raw: Buffer.from(raw, "base64url").toString("utf8") });
      return json(res, 200, { id, message: { id: rand("m-").slice(0, 18), labelIds: ["DRAFT"] } });
    }
    const path = url.pathname.replace("/gmail/v1/users/me/messages", "");
    if (req.method === "POST" && path === "/send") {
      if (!bearer(req, res, GMAIL_SEND)) return;
      const raw = JSON.parse(body || "{}").raw;
      if (typeof raw !== "string") return apiError(res, 400, "'raw' RFC822 payload message string or uploading message via /upload/* URL required");
      const id = rand("sent-").slice(0, 21);
      sent.push({ id, raw: Buffer.from(raw, "base64url").toString("utf8") });
      return json(res, 200, { id, threadId: id, labelIds: ["SENT"] });
    }
    if (!bearer(req, res, GMAIL_READ)) return;
    if (path === "") {
      const q = (url.searchParams.get("q") ?? "").split(" ").filter((w) => w && !w.includes(":")).join(" ").toLowerCase();
      const found = messages.filter((m) => !q || `${m.subject} ${m.from} ${m.text ?? ""}`.toLowerCase().includes(q));
      const max = Math.min(Number(url.searchParams.get("maxResults") ?? 100) || 100, 500);
      const start = Number(Buffer.from(url.searchParams.get("pageToken") ?? "MA", "base64url").toString()) || 0;
      const page = found.slice(start, start + max).map((m) => ({ id: m.id, threadId: m.threadId ?? m.id }));
      const out = { messages: page, resultSizeEstimate: found.length };
      if (start + max < found.length) out.nextPageToken = b64url(String(start + max));
      return json(res, 200, page.length ? out : { resultSizeEstimate: 0 });
    }
    const m = messages.find((x) => `/${x.id}` === path);
    if (!m) return apiError(res, 404, "Requested entity was not found.");
    const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
    return json(res, 200, messageResource(m, url.searchParams.get("format") ?? "full", wanted));
  }

  // Google sends invites only with sendUpdates=all or externalOnly. Each one goes to `invites`.
  const invite = (url, event) => {
    if (["all", "externalOnly"].includes(url.searchParams.get("sendUpdates") ?? "")) invites.push(...(event.attendees ?? []).map((a) => ({ to: a.email, event: event.id })));
  };

  function calendar(req, res, url, body) {
    const id = url.pathname.split("/events/")[1];
    if (req.method === "POST" || req.method === "PATCH") {
      if (!bearer(req, res, CAL_WRITE)) return;
      const input = JSON.parse(body || "{}");
      const old = id ? events.find((e) => e.id === decodeURIComponent(id)) : undefined;
      if (id && !old) return apiError(res, 404, "Not Found");
      if (!id && (!input.start?.dateTime || !input.end?.dateTime)) return apiError(res, 400, "Missing time.");
      const me = { email: "me@example.com", self: true };
      const event = old ? Object.assign(old, input) : { kind: "calendar#event", id: rand("ev").slice(0, 26), status: "confirmed", htmlLink: "https://calendar.google.com/event?eid=fake", organizer: me, creator: me, ...input };
      if (!old) events.push(event);
      writes.push({ method: req.method, sendUpdates: url.searchParams.get("sendUpdates"), id: event.id });
      invite(url, event);
      return json(res, 200, event);
    }
    if (!bearer(req, res, CAL_READ)) return;
    if (id) {
      const event = events.find((e) => e.id === decodeURIComponent(id));
      return event ? json(res, 200, event) : apiError(res, 404, "Not Found");
    }
    const min = Date.parse(url.searchParams.get("timeMin") ?? "") || -Infinity;
    const maxT = Date.parse(url.searchParams.get("timeMax") ?? "") || Infinity;
    const max = Math.min(Number(url.searchParams.get("maxResults") ?? 250) || 250, 2500);
    const items = events
      .filter((e) => Date.parse(e.end.dateTime) > min && Date.parse(e.start.dateTime) < maxT)
      .toSorted((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
      .slice(0, max);
    return json(res, 200, { kind: "calendar#events", summary: "me@example.com", items });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const sub = (req.headers.host ?? "").split(".")[0];
    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
    log.push({ host: sub, method: req.method, path: url.pathname, token: auth, origin: req.headers.origin ?? null });
    try {
      const body = ["POST", "PATCH"].includes(req.method ?? "") && !["/token", "/revoke"].includes(url.pathname) ? await readBody(req) : "";
      if (url.pathname === "/pixel.gif") {
        counts.pixel += 1;
        return res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
      }
      if (sub === "accounts" && url.pathname === "/o/oauth2/v2/auth") return authorize(url, res);
      if (sub === "accounts" && url.pathname === "/o/oauth2/v2/approve") return approve(url.searchParams.get("id"), res);
      if (sub === "oauth2" && req.method === "POST" && url.pathname === "/token") return await token(req, res);
      if (sub === "oauth2" && req.method === "POST" && url.pathname === "/revoke") return await revoke(req, res, url);
      if (sub === "gmail" && url.pathname.startsWith("/gmail/v1/users/me/")) return gmail(req, res, url, body);
      if (sub === "www" && url.pathname.startsWith("/calendar/v3/calendars/primary/events")) return calendar(req, res, url, body);
      apiError(res, 404, "Not found.");
    } catch (error) {
      apiError(res, 500, String(error));
    }
  });
  await new Promise((done) => server.listen(0, "::", done));
  const { port } = server.address();
  const origin = (sub) => `http://${sub}.localhost:${port}`;

  return {
    port,
    origin,
    endpoints: {
      authorizeUrl: `${origin("accounts")}/o/oauth2/v2/auth`,
      tokenUrl: `${origin("oauth2")}/token`,
      revokeUrl: `${origin("oauth2")}/revoke`,
      gmailBase: `${origin("gmail")}/gmail/v1`,
      calendarBase: `${origin("www")}/calendar/v3`,
    },
    behavior,
    log,
    issued,
    counts,
    sent,
    drafts,
    events,
    invites,
    writes,
    /** @param {{ id: string, secret?: string, redirectUris: string[] }} client */
    addClient({ id, secret, redirectUris }) {
      clients.set(id, { id, secret, redirectUris });
      if (secret) issued.push(secret);
    },
    addMessages(list) {
      messages.push(...list);
    },
    addEvents(list) {
      events.push(...list.map((e, i) => ({ kind: "calendar#event", id: e.id ?? `ev${events.length + i}`, status: "confirmed", ...e })));
    },
    /** The access tokens stop working now, as if they expired on the server. */
    expireAccessTokens() {
      for (const a of access.values()) a.exp = 0;
    },
    /** True when the refresh token still works. */
    refreshTokenWorks: (value) => Boolean(grants.get(value) && !grants.get(value).revoked),
    close: () => new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

/**
 * What identity.launchWebAuthFlow does, for Node tests: load the URL, follow
 * redirects and the consent page, and return the first URL that starts with
 * the redirect_uri. It throws on an error page, as Firefox does.
 */
export async function nodeAuthFlow({ url }) {
  const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
  let next = url;
  for (let hop = 0; hop < 5; hop += 1) {
    if (next.startsWith(redirect)) return next;
    const res = await fetch(next, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      next = new URL(res.headers.get("location") ?? "", next).href;
      continue;
    }
    const html = await res.text();
    const allow = /id="allow" href="([^"]+)"/.exec(html);
    if (res.status !== 200 || !allow?.[1]) throw new Error("Authorization page could not be loaded");
    next = new URL(allow[1], next).href;
  }
  throw new Error("Too many redirects");
}
