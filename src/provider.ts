import { FoxlinkError } from "./errors.js";

/** An OAuth 2.0 provider that issues codes with PKCE. */
export interface ProviderConfig {
  /** A short name, `a-z 0-9 -`. foxlink uses it in vault handles and store keys. */
  id: string;
  clientId: string;
  /** Only for providers that want one from an installed app. It is sent to the token endpoint only. */
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** The scopes that `connect()` asks for by default. */
  scopes: string[];
  /** The most that `connect({ scopes })` may ask for. Default: `scopes`. */
  allowedScopes?: string[];
  /** The hosts that get the access token. */
  apiHosts: string[];
  /** More parameters for the authorize URL. */
  authParams?: Record<string, string>;
  /** `loopback` gives `http://127.0.0.1/mozoauth2/<id>`. `extension` gives `identity.getRedirectURL()`. */
  redirect?: "loopback" | "extension";
  /** The `iss` values to accept in an ID token. */
  issuers?: string[];
  /** Allow `http:` endpoints and API hosts. Only for test servers. */
  allowHttp?: boolean;
}

export type Provider = Readonly<Required<Omit<ProviderConfig, "clientSecret" | "revokeUrl">>> & { readonly clientSecret?: string; readonly revokeUrl?: string };

const bad = (message: string) => new FoxlinkError("bad-config", message);

function checkUrl(value: unknown, name: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw bad(`${name} is not a URL.`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw bad(`${name} must use https.`);
  return url.href;
}

const scopeList = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === "string" && /^\S{1,200}$/.test(s))) throw bad(`${name} must be a list of scopes.`);
  return [...new Set(value as string[])];
};

/** Check a provider config and freeze it. Throws `bad-config`. */
export function defineProvider(config: ProviderConfig): Provider {
  if (!/^[a-z0-9-]{1,32}$/.test(String(config.id))) throw bad("id must be 1-32 of a-z, 0-9, and -.");
  if (typeof config.clientId !== "string" || !/^\S{1,300}$/.test(config.clientId)) throw bad("Type an OAuth client ID.");
  if (config.clientSecret !== undefined && (typeof config.clientSecret !== "string" || !config.clientSecret)) throw bad("clientSecret must be a string.");
  const allowHttp = config.allowHttp === true;
  const scopes = scopeList(config.scopes, "scopes");
  const allowedScopes = config.allowedScopes === undefined ? scopes : scopeList(config.allowedScopes, "allowedScopes");
  if (!scopes.every((s) => allowedScopes.includes(s))) throw bad("allowedScopes must hold every default scope.");
  if (!Array.isArray(config.apiHosts) || config.apiHosts.length === 0 || !config.apiHosts.every((h) => typeof h === "string" && /^[a-z0-9.-]+$/.test(h))) {
    throw bad("apiHosts must be a list of host names.");
  }
  const provider: Provider = {
    id: config.id,
    clientId: config.clientId,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    authorizeUrl: checkUrl(config.authorizeUrl, "authorizeUrl", allowHttp),
    tokenUrl: checkUrl(config.tokenUrl, "tokenUrl", allowHttp),
    ...(config.revokeUrl ? { revokeUrl: checkUrl(config.revokeUrl, "revokeUrl", allowHttp) } : {}),
    scopes,
    allowedScopes,
    apiHosts: [...config.apiHosts],
    authParams: { ...config.authParams },
    redirect: config.redirect ?? "extension",
    issuers: [...(config.issuers ?? [])],
    allowHttp,
  };
  return Object.freeze(provider);
}

/** `http://127.0.0.1/mozoauth2/<subdomain>` from the URL that `identity.getRedirectURL()` returns (Firefox 86+). */
export function loopbackRedirectUrl(extensionRedirectUrl: string): string {
  const sub = new URL(extensionRedirectUrl).hostname.split(".")[0];
  if (!sub) throw new FoxlinkError("bad-config", "The extension redirect URL has no subdomain.");
  return `http://127.0.0.1/mozoauth2/${sub}`;
}

/** Google scopes that the Gmail and Calendar clients use. */
export const GOOGLE_SCOPES = Object.freeze({
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
});

export interface GoogleEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  gmailBase: string;
  calendarBase: string;
}

export const GOOGLE_ENDPOINTS: Readonly<GoogleEndpoints> = Object.freeze({
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  gmailBase: "https://gmail.googleapis.com/gmail/v1",
  calendarBase: "https://www.googleapis.com/calendar/v3",
});

export interface ProviderOptions {
  clientId: string;
  clientSecret?: string;
  /** Default: Gmail read and Calendar read. */
  scopes?: string[];
  /** Default: `scopes`. Add `GOOGLE_SCOPES.gmailSend` or `calendarEvents` to let `connect` ask for them. */
  allowedScopes?: string[];
  /** Other endpoints, for a test server. */
  endpoints?: Partial<GoogleEndpoints>;
  allowHttp?: boolean;
}

const hostOf = (url: string, name: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    throw bad(`${name} is not a URL.`);
  }
};

/** The Google preset: loopback redirect, offline access, and read-only scopes by default. */
export function googleProvider(options: ProviderOptions): Provider & { readonly endpoints: Readonly<GoogleEndpoints> } {
  const endpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const scopes = options.scopes ?? [GOOGLE_SCOPES.gmailRead, GOOGLE_SCOPES.calendarRead];
  const provider = defineProvider({
    id: "google",
    clientId: options.clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    authorizeUrl: endpoints.authorizeUrl,
    tokenUrl: endpoints.tokenUrl,
    revokeUrl: endpoints.revokeUrl,
    scopes,
    allowedScopes: options.allowedScopes ?? scopes,
    apiHosts: [...new Set([hostOf(endpoints.gmailBase, "gmailBase"), hostOf(endpoints.calendarBase, "calendarBase")])],
    // Google sends a refresh token only with offline access, and again only with consent.
    authParams: { access_type: "offline", prompt: "consent" },
    redirect: "loopback",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    allowHttp: options.allowHttp === true,
  });
  checkUrl(endpoints.gmailBase, "gmailBase", provider.allowHttp);
  checkUrl(endpoints.calendarBase, "calendarBase", provider.allowHttp);
  return Object.freeze({ ...provider, endpoints: Object.freeze(endpoints) });
}
