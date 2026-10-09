// Builds extension/ into dist-ext/: esbuild bundles each script, and the
// other files are copied. It stops when the manifest version is not the
// package.json version, so AMO signs the version that npm publishes.
// With --e2e it builds for e2e/run.mjs: it sets globalThis.FOXLINK_E2E, so
// the local server port works, and adds http://*.localhost/* for the fake
// Google. The release build (no flag) has neither (E10, E11).
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const e2e = process.argv.includes("--e2e");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

rmSync("dist-ext", { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`),
  outdir: "dist-ext",
  bundle: true,
  format: "iife",
  target: "firefox153",
  logLevel: "warning",
  define: { "globalThis.FOXLINK_E2E": String(e2e) },
});
for (const file of files.filter((f) => !f.endsWith(".js") && f !== "amo-metadata.json")) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });
if (e2e) writeFileSync("dist-ext/manifest.json", `${JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, "http://*.localhost/*"] }, null, 2)}\n`);
console.log(`Built dist-ext/ (version ${pkg.version}${e2e ? ", e2e" : ""}).`);
