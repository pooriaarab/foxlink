// The E2E test: install the demo extension (dist-ext/) in a real Firefox,
// point it at the fake Google in e2e/fake-google.mjs, drive the popup, and
// write artifacts/e2e-<date>.json. It checks E1-E9 and E12-E14 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
//
// identity.launchWebAuthFlow runs for real: it opens the fake consent page in
// a window and catches the loopback redirect http://127.0.0.1/mozoauth2/...
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";
import { startFakeGoogle } from "./fake-google.mjs";

const CLIENT_ID = "foxlink-e2e.apps.googleusercontent.com";
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const hours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

// Click a button, wait until the output counts one more answer, and return its text.
async function press(page, button, output = "#result") {
  const before = await page.evaluate((o) => Number(document.querySelector(o).dataset.runs ?? 0), output);
  await page.evaluate((b) => document.querySelector(b).click(), button);
  await poll(page, ([o, n]) => Number(document.querySelector(o).dataset.runs ?? 0) > n, [output, before]);
  return page.evaluate((o) => document.querySelector(o).textContent, output);
}
const items = (page) => page.evaluate(() => [...document.querySelectorAll("#list li")].map((li) => li.textContent));
const storageDump = (page) => page.evaluate(async () => JSON.stringify(await browser.storage.local.get(null)));
const leaked = (text, g) => g.issued.filter((v) => text.includes(v)).length;

const g = await startFakeGoogle();
g.behavior.consent = "page";
g.addEvents([
  { summary: "Past", start: { dateTime: hours(-3) }, end: { dateTime: hours(-2) } },
  { summary: "Standup", start: { dateTime: hours(1) }, end: { dateTime: hours(1.5) } },
  { summary: "Dentist", start: { dateTime: hours(3) }, end: { dateTime: hours(4) } },
  { summary: "Lunch with Ana", start: { dateTime: hours(5) }, end: { dateTime: hours(6) } },
  { summary: "Flight", start: { dateTime: hours(30) }, end: { dateTime: hours(33) } },
]);
const pixel = `${g.origin("www")}/pixel.gif?track=e2e`;
g.addMessages([
  { id: "m0", from: "shop@example.com", to: "me@example.com", subject: "Your order shipped", date: "Fri, 09 Oct 2026 08:00:00 +0000", html: `<p>Hello,</p><img src="${pixel}" width="1" height="1"><script>steal()</script><p>Your order is on the way.</p>` },
  ...["Team lunch", "Invoice 42", "Weekend plans", "Re: the report", "Older note", "Oldest"].map((subject, i) => ({ id: `m${i + 1}`, from: "friend@example.com", to: "me@example.com", subject, date: "Thu, 08 Oct 2026 10:00:00 +0000", text: `Body ${i}` })),
]);
const site = await serve("e2e/site");
let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const popup = await fox.openExtensionPage("popup.html");

  check("E2: connect with no client ID asks for one", "Type your OAuth client ID first.", await press(popup, "#connect"));
  check("E2: no authorize request was sent", 0, g.log.filter((r) => r.host === "accounts").length);

  const redirect = await poll(popup, () => document.getElementById("redirect").textContent);
  record.redirectUri = redirect;
  g.addClient({ id: CLIENT_ID, redirectUris: [redirect] });
  await popup.evaluate(([id, port]) => {
    document.getElementById("client-id").value = id;
    document.getElementById("test-port").value = port;
  }, [CLIENT_ID, String(g.port)]);
  check("settings saved", "Saved", await press(popup, "#save"));

  const status = await press(popup, "#connect", "#status");
  check("E1: launchWebAuthFlow connects through the fake consent page", "Connected (gmail.readonly, calendar.readonly)", status);
  check("E1: the redirect URI is the Firefox loopback form", true, /^http:\/\/127\.0\.0\.1\/mozoauth2\/[0-9a-f]{40}$/.test(redirect));
  check("E1: one code exchange at the token endpoint", 1, g.counts.token);

  await press(popup, "#events");
  check("E3: the next 3 events", ["Standup", "Dentist", "Lunch with Ana"], (await items(popup)).map((t) => t.split(" ").slice(1).join(" ")));
  await press(popup, "#subjects");
  check("E3: the 5 latest subjects", ["Your order shipped", "Team lunch", "Invoice 42", "Weekend plans", "Re: the report"], (await items(popup)).map((t) => t.replace(/ \(.*\)$/, "")));
  const apiCalls = g.log.filter((r) => r.host === "gmail" || r.host === "www");
  check("L5: every API request carried a token that foxvault added", true, apiCalls.length > 0 && apiCalls.every((r) => r.token && g.issued.includes(r.token)));

  check("E5: storage.local holds no token", 0, leaked(await storageDump(popup), g));

  g.expireAccessTokens();
  await press(popup, "#subjects");
  check("E4: after the server expired the token, the list still works", 5, (await items(popup)).length);
  check("E4: one refresh", 1, g.counts.refresh);
  check("E5: storage.local holds no token after refresh", 0, leaked(await storageDump(popup), g));

  await press(popup, "#read");
  const text = await popup.evaluate(() => document.getElementById("text").textContent);
  check("E7: the HTML email shows as plain text", "Your order shipped\n\nHello,\nYour order is on the way.", text);
  check("E7: the tracking pixel was never loaded", 0, g.counts.pixel);

  await popup.evaluate(() => {
    for (const [id, value] of [["to", "bob@example.com"], ["cc", "cy@example.com"], ["bcc", "dee@example.com"], ["subject", "Hello from foxlink"], ["body", "This is a test."]]) document.getElementById(id).value = value;
    const files = new DataTransfer();
    files.items.add(new File(["line 1\n"], "notes.txt", { type: "text/plain" }));
    document.getElementById("files").files = files.files;
  });
  check("E12, E8: send asks first", "Waiting for approval", await press(popup, "#send"));
  check("E12: the send ran one more consent and code exchange", 2, g.counts.token - g.counts.refresh);
  const pending = await popup.evaluate(() => document.getElementById("pending").textContent);
  record.approvalText = pending;
  check("E8: the approval shows every recipient, the body, and the file", true, ["bob@example.com", "cy@example.com", "dee@example.com", "Hello from foxlink", "This is a test.", "notes.txt (text/plain, 7 bytes"].every((t) => pending.includes(t)));
  await popup.evaluate(() => (document.getElementById("body").value = "This is a test. Also wire me $500."));
  check("E13: an edit after the approval is refused", "refused: action-changed", await press(popup, "#approve"));
  check("E13: nothing was sent", 0, g.sent.length);
  await popup.evaluate(() => (document.getElementById("body").value = "This is a test."));
  check("E8: send asks again", "Waiting for approval", await press(popup, "#send"));
  check("E8: approve sends it", "Sent", await press(popup, "#approve"));
  check("E8: the message arrived one time, with cc, bcc, and the file", [1, true], [g.sent.length, ["Cc: cy@example.com", "Bcc: dee@example.com", 'filename="notes.txt"'].every((t) => g.sent[0]?.raw.includes(t))]);
  const replay = await popup.evaluate(async () => {
    const message = { to: "bob@example.com", subject: "Replay", body: "Once." };
    const ask = (await browser.runtime.sendMessage({ type: "send", message })).ok;
    const { token } = (await browser.runtime.sendMessage({ type: "approve", requestId: ask.requestId })).ok;
    const first = (await browser.runtime.sendMessage({ type: "send", message, token })).ok;
    const second = (await browser.runtime.sendMessage({ type: "send", message, token })).ok;
    return [first.status, second.reason];
  });
  check("E14: the same token sends one time, then token-used", ["sent", "token-used"], replay);
  check("E14: the fake Gmail has one copy", 1, g.sent.filter((m) => m.raw.includes("Subject: Replay")).length);

  const page = await fox.open(`${site.url}/index.html`);
  await page.evaluate((url) => fetch(url).catch(() => null), `${g.endpoints.gmailBase}/users/me/messages`);
  await new Promise((done) => setTimeout(done, 500));
  const fromPage = g.log.filter((r) => r.origin === site.url);
  check("E6: a web page request to the API host has no token", [null], fromPage.map((r) => r.token));

  const refresh = g.issued.filter((v) => v.startsWith("1//")).at(-1);
  check("E9: disconnect", "Revoked at the provider", await press(popup, "#disconnect"));
  check("E9: the old refresh token no longer works", false, g.refreshTokenWorks(refresh));
  check("E9: storage.local holds no token after disconnect", 0, leaked(await storageDump(popup), g));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site.close();
  await g.close();
}
record.passed = !record.error && record.checks.length === 29 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"} ${record.checks.length} checks${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
