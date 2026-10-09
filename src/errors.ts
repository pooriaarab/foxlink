/** Why foxlink refused. Callers can switch on `code`. Messages never hold a token, a code, or server text. */
export type FoxlinkErrorCode =
  | "bad-config"
  | "bad-scope"
  | "busy"
  | "authorize-failed"
  | "redirect-mismatch"
  | "state-mismatch"
  | "access-denied"
  | "token-error"
  | "scope-creep"
  | "id-token"
  | "not-connected"
  | "reconnect"
  | "unauthorized"
  | "bad-host"
  | "http-error"
  | "missing-scope"
  | "bad-input";

export class FoxlinkError extends Error {
  readonly code: FoxlinkErrorCode;
  /** The HTTP status, when a server answered. */
  readonly status?: number;
  /** The OAuth `error` code from the server, cut to `a-z 0-9 _`. */
  readonly oauthError?: string;

  constructor(code: FoxlinkErrorCode, message: string, extra: { status?: number; oauthError?: string } = {}) {
    super(message);
    this.name = "FoxlinkError";
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.oauthError) this.oauthError = extra.oauthError;
  }
}

/** An OAuth error code from a server, made safe to show: `a-z 0-9 _`, 40 characters at most. */
export const safeCode = (value: unknown): string =>
  typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) : "";
