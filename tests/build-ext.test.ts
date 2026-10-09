// Failure modes E10 and E11 in docs/failure-modes.md: the release build has
// no path to the local fake Google; only the e2e build has it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function build(...args: string[]) {
  execFileSync("node", ["scripts/build-ext.mjs", ...args], { stdio: "pipe" });
  const manifest = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8")) as { host_permissions: string[] };
  const bundle = ["background.js", "popup.js"].map((f) => readFileSync(`dist-ext/${f}`, "utf8")).join("\n");
  return { hosts: manifest.host_permissions, bundle, html: readFileSync("dist-ext/popup.html", "utf8") };
}

describe("build-ext", () => {
  // Runs the e2e build first and the release build last, so dist-ext/ ends as the release build.
  it("E10/E11: the e2e build reaches the local fake Google", () => {
    const e2e = build("--e2e");
    expect(e2e.hosts).toContain("http://*.localhost/*");
    expect(e2e.bundle).toContain(".localhost:");
  }, 30_000);

  it("E10: the release build asks for the Google hosts only", () => {
    expect(build().hosts).toEqual(["https://accounts.google.com/*", "https://oauth2.googleapis.com/*", "https://gmail.googleapis.com/*", "https://www.googleapis.com/*"]);
  }, 30_000);

  it("E11: the release build has no local endpoint and hides the local server field", () => {
    const release = build();
    expect(release.bundle).not.toContain(".localhost");
    expect(release.html).toMatch(/<label id="local-server" hidden>/);
  }, 30_000);
});
