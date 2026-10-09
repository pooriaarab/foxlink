import type { Action, Gate } from "foxgate";

/** The foxgate tools that foxlink uses. Register them with `createFoxgate({ tools: FOXLINK_TOOLS })`. */
export const FOXLINK_TOOLS = Object.freeze({
  "foxlink.gmail.send": "submit",
  "foxlink.calendar.create": "submit",
} as const);

export type Refused = { status: "refused"; reason: string };
export type Asked = { status: "ask"; requestId: string };

/**
 * Ask the gate about one write. With a token, redeem it for the same action.
 * `run` gets the args that the gate judged, never the caller's copy.
 */
export async function gated<T>(
  gate: Gate | undefined,
  action: Action,
  token: string | undefined,
  run: (args: Record<string, unknown>) => Promise<T>,
): Promise<T | Asked | Refused> {
  if (!gate) return { status: "refused", reason: "no-gate" };
  const decision = token === undefined ? await gate.check(action) : await gate.redeem(token, action);
  if (decision.decision === "ask") return { status: "ask", requestId: decision.requestId };
  if (decision.decision === "deny") return { status: "refused", reason: decision.reason };
  return run(decision.action.args);
}

export const hasControl = (value: string) => /[\r\n\0]/.test(value);
