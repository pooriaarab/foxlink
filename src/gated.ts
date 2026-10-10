import type { Action, Gate } from "foxgate";
import { FoxlinkError } from "./errors.js";
import type { Link } from "./link.js";

/** The foxgate tools that foxlink uses. Register them with `createFoxgate({ tools: FOXLINK_TOOLS })`. */
export const FOXLINK_TOOLS = Object.freeze({
  "foxlink.gmail.send": "submit",
  "foxlink.gmail.draft": "submit",
  "foxlink.calendar.create": "submit",
} as const);

export type Refused = { status: "refused"; reason: string };
export type Asked = { status: "ask"; requestId: string };

/**
 * Ask the gate about one write. With a token, redeem it for the same action.
 * `run` gets the args that the gate judged, never the caller's copy.
 * With `human`, an "allow" without a token is refused (approval-required).
 */
export async function gated<T>(
  gate: Gate | undefined,
  action: Action,
  token: string | undefined,
  run: (args: Record<string, unknown>) => Promise<T>,
  human = false,
): Promise<T | Asked | Refused> {
  if (!gate) return { status: "refused", reason: "no-gate" };
  const decision = token === undefined ? await gate.check(action) : await gate.redeem(token, action);
  if (decision.decision === "ask") return { status: "ask", requestId: decision.requestId };
  if (decision.decision === "deny") return { status: "refused", reason: decision.reason };
  if (human && token === undefined) return { status: "refused", reason: "approval-required" };
  return run(decision.action.args);
}

/** Incremental consent: when no scope in `accepted` is granted, connect again for the granted scopes plus `ask`. */
export async function withScope(link: Link, accepted: string[], ask: string): Promise<Refused | undefined> {
  for (const s of accepted) if (await link.hasScope(s)) return undefined;
  if (!link.provider.allowedScopes.includes(ask)) return { status: "refused", reason: "missing-scope" };
  const now = await link.status();
  try {
    await link.connect({ scopes: [...(now.connected ? now.scopes : link.provider.scopes), ask] });
  } catch (error) {
    if (error instanceof FoxlinkError) return { status: "refused", reason: error.code };
    throw error;
  }
  return (await link.hasScope(ask)) ? undefined : { status: "refused", reason: "missing-scope" };
}

export const hasControl = (value: string) => /[\r\n\0]/.test(value);
