# foxlink-oauth

[![npm version](https://img.shields.io/npm/v/foxlink-oauth)](https://www.npmjs.com/package/foxlink-oauth)
[![Downloads/month](https://img.shields.io/npm/dm/foxlink-oauth)](https://www.npmjs.com/package/foxlink-oauth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)
[![Types included](https://img.shields.io/badge/types-included-blue)](#runtime-surfaces)

[Setup](#install) · [Quickstart](#read-your-first-messages-and-events) · [API reference](#runtime-surfaces) · [Comparisons](#compare)

foxlink-oauth is an open-source OAuth client library for Firefox extension developers who read Gmail and Google Calendar.
It implements authorization codes with Proof Key for Code Exchange (PKCE) and stores tokens through foxvault.
Email sends and calendar writes require approval through foxgate.

## Install

```bash
npm i foxlink-oauth foxvault foxgate
```

The package declares Node.js 24+ and includes TypeScript declarations.
Its two direct runtime dependencies are foxvault and foxgate. Browser header injection needs Firefox extension APIs.

## Read your first messages and events

This code runs in the background script of a Firefox extension. The
extension needs the permissions `identity`, `storage`, `webRequest`, and
`webRequestBlocking`, and host permissions for the Google hosts. The
extension in `extension/` makes the same calls.

```js
import { storageAreaStore } from "foxgate";
import { attachHeaderInjection, createVault, indexedDbKeyStore } from "foxvault";
import { calendar, createLink, gmail, googleProvider } from "foxlink-oauth";

const store = storageAreaStore(browser.storage.local);
const vault = createVault({ store, keyStore: indexedDbKeyStore() });
attachHeaderInjection(vault, browser); // at the top level of the event page

const provider = googleProvider({
  clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  clientSecret: "YOUR_DESKTOP_CLIENT_SECRET",
});
const link = createLink({ provider, vault, store, identity: browser.identity, transport: "inject" });

// Call this from a message handler, for example when the user selects a button.
async function today() {
  if ((await vault.status()) === "new") await vault.initialize();
  if (!(await link.status()).connected) await link.connect(); // opens the Google sign-in window
  const { events } = await calendar(link).listEvents({ max: 3 });
  const { messages } = await gmail(link).listMessages({ max: 5 });
  const result = { events: events.map((e) => e.summary), subjects: messages.map((m) => m.subject) };
  console.log(result);
  return result;
}
```

Register a Google OAuth client and supply its values above. See [Google setup](#use-your-own-google-client-id).
Invoke `today()` from a user action through your extension message handler.
Success prints `{ events: [...], subjects: [...] }`; empty arrays mean an empty calendar or inbox.
No environment variables or `.env` loading are required. Google credentials and live redirect acceptance need your own validation.

For a credential-free smoke check, save this as `text.mjs` and run `node text.mjs`:

```js
import { htmlToText } from "foxlink-oauth";

console.log(htmlToText('<p>Hi &amp; welcome</p><img src="https://t.example/p.gif"><script>steal()</script>'));
// Hi & welcome
```

## How it works

```text
Extension -> Firefox sign-in -> OAuth provider -> code and state
Extension -> checked code exchange -> encrypted tokens in foxvault
Gmail/Calendar read -> link.fetch -> approved API host
Gmail/Calendar write -> foxgate approval -> exact approved action -> API
```

The link checks redirect origin, path, state, and granted scopes before it stores tokens.
Header injection keeps API access tokens out of calling code. The alternative `use` transport builds headers in trusted host code.
A shared refresh request handles concurrent callers. One 401 can trigger one refresh and request retry.

## Why it exists

[oauth4webapi](https://github.com/panva/oauth4webapi) supplies general OAuth protocol routines.
[Auth0 SPA SDK](https://auth0.github.io/auth0-spa-js/index.html) supplies browser authentication for Auth0 applications.
foxlink-oauth joins Firefox sign-in, token storage, and approval-gated Gmail and Calendar operations in one library.

## Compare

Scope checked on 2026-10-14 against the linked official documentation. These libraries address different application surfaces.

| Item | foxlink-oauth | [oauth4webapi](https://github.com/panva/oauth4webapi) | [Auth0 SPA SDK](https://auth0.github.io/auth0-spa-js/index.html) |
|---|---|---|---|
| Scope | OAuth plus Gmail/Calendar clients | OAuth/OpenID Connect routines | Auth0 browser authentication |
| Deployment | Extension or trusted host | JavaScript runtime | Browser application |
| Configuration | Provider and vault objects | Protocol calls and metadata | Auth0 client options |
| License | MIT | MIT | MIT |

## Coverage

| Integration | Status | Verification |
|---|---|---|
| Google OAuth | ✓ | Preset and fake-server tests; live credentials pending |
| Gmail | ✓ | Reads, drafts, sends; fake-server tests |
| Google Calendar | ✓ | Reads, creates, updates; fake-server tests |
| Other PKCE providers | — | Configuration interface only; no other preset ships |

One provider preset and two service clients ship. Zero integrations are credential-checked against a real Google account in this repository.
The E2E suite uses a local fake Google server. Provider acceptance and account policy remain pending live verification.

## Common use cases

1. Firefox extension authors: show Gmail subjects and upcoming Google Calendar events in a popup.
2. Email assistant authors: create Gmail drafts with `draftOnly` before a person reviews them.
3. Browser agent authors: use foxgate to approve exact Gmail recipients, text, and attachments.
4. Scheduling assistant authors: approve Google Calendar changes and choose whether to send attendee updates.
5. Agent auditors: pass a foxtrail log to record send identifiers and hashes without email bodies.

## Features

- **Provider configuration:** define endpoints, scopes, redirects, and allowed API hosts; see [providers](#providers).
- **Token refresh:** refresh before expiry and retry one unauthorized request.
- **Approved writes:** register four foxgate tool entries; see [Gmail and Calendar](#gmail-and-calendar).
- **Text handling:** return untrusted records and convert HTML without loading images; see [text](#text).
- **Local demo:** build the [Firefox extension](#demo-extension) with your own Google client.

## Runtime surfaces

The package exports a library, with no command-line interface (CLI) or Model Context Protocol (MCP) server.
Firefox uses `identity` and header injection. The `use` transport accepts custom launch and fetch functions in other runtimes.

### Providers

| Export | What it does |
|---|---|
| `googleProvider({ clientId, clientSecret?, scopes?, allowedScopes?, endpoints?, allowHttp? })` | The Google preset. Default scopes: `gmail.readonly` and `calendar.readonly`. `allowedScopes` is the most that `connect` may ask for. It uses the loopback redirect and asks for offline access. |
| `defineProvider(config)` | Any provider. `config` has `id`, `clientId`, `authorizeUrl`, `tokenUrl`, `revokeUrl?`, `scopes`, `allowedScopes?`, `apiHosts`, `authParams?`, `redirect?` (`"extension"` or `"loopback"`), `issuers?`, and `allowHttp?`. |
| `GOOGLE_SCOPES` | `gmailRead`, `gmailSend`, `gmailCompose`, `calendarRead`, and `calendarEvents`. |
| `GOOGLE_ENDPOINTS` | The Google authorize, token, revoke, Gmail, and Calendar URLs. |
| `loopbackRedirectUrl(url)` | `http://127.0.0.1/mozoauth2/<subdomain>` from the value of `identity.getRedirectURL()`. |

`allowHttp` is for test servers only. Without it, every endpoint must use
`https:`.

#### Scopes

| Scope | Used by | When foxlink asks for it |
|---|---|---|
| `gmail.readonly` | `listMessages`, `getMessage` | At `connect`, by default. |
| `calendar.readonly` | `listEvents` | At `connect`, by default. |
| `gmail.send` | `sendMessage` | At the first send, when `allowedScopes` holds it. |
| `gmail.compose` | `createDraft` | At the first draft, when `allowedScopes` holds it. |
| `calendar.events` | `createEvent`, `patchEvent` | At the first event write, when `allowedScopes` holds it. |

A write scope request is a new `connect`, so the user sees Google consent again.

### `createLink(options)`

| Option | Default | What it does |
|---|---|---|
| `provider` | required | From `googleProvider` or `defineProvider`. |
| `vault` | required | A foxvault vault. |
| `store` | `memoryStore()` | Where the token record lives. In Firefox, `storageAreaStore(browser.storage.local)`. |
| `identity` | none | `browser.identity`. foxlink uses it for the redirect URI and the sign-in window. |
| `redirectUri` | from `identity` | Set it to use another redirect URI. |
| `launch` | `identity.launchWebAuthFlow` | Opens the authorize URL and returns the redirect URL. |
| `transport` | `"use"` | `"inject"`: foxvault adds the header in Firefox, with `attachHeaderInjection`. `"use"`: foxlink adds it in your host code, for example in Node. |
| `fetch` | global `fetch` | The fetch function. |
| `now` | `Date.now` | The clock. |
| `skewMs` | 60,000 | Refresh this long before the access token expires. foxlink uses half of the token life when that is shorter. |

| Method | What it does |
|---|---|
| `connect({ scopes?, interactive? })` | Runs the sign-in. Returns the status. |
| `status()` | `{ connected, scopes, expiresAt?, refreshable? }`. It holds no token. |
| `hasScope(scope)` | True when the user granted the scope. |
| `fetch(url, init?)` | `fetch` for the API hosts, with the access token. |
| `disconnect()` | Revokes the grant and forgets the tokens. Returns `{ revoked }`. It forgets them also when the revoke fails. |
| `redirectUri()` | The redirect URI to register with the provider. |

### Gmail and Calendar

| Method | What it does |
|---|---|
| `gmail(link, { gate? }).listMessages({ query?, max?, pageToken? })` | The newest messages with From, To, Subject, Date, and the snippet. `max` is 1 to 50 (default 10). Returns `{ messages, nextPageToken? }`. |
| `gmail(link).getMessage(id)` | One message with `text`: the `text/plain` part, or the HTML part as plain text. |
| `gmail(link, { gate, trail?, draftOnly?, privateMode? })` | `trail` is a foxtrail `Log`. A trail write that fails gives `logged: false`. `privateMode` returns true while the run is in private-data mode: then each approval holds `privateData: true`. |
| `gmail(link, { gate }).sendMessage({ to, cc?, bcc?, subject, body, attachments? }, { token? })` | A plain text email, after a foxgate approval. `attachments` is a list of `{ filename, mimeType, data }`, with `data` a `Uint8Array`. A subject with non-ASCII characters or `=?` goes out as RFC 2047 encoded words, so the recipient sees the approved text. Returns `{ status: "sent", id, sha256 }`, `{ status: "ask", requestId }`, or `{ status: "refused", reason }`. |
| `gmail(link).createDraft(message, { token? })` | Saves the same message as a Gmail draft, with no approval. In private-data mode it asks foxgate first. Returns `{ status: "drafted", id, sha256 }`. |
| `calendar(link).listEvents({ timeMin?, timeMax?, max? })` | The next events from `timeMin` (default: now), by start time. Returns `{ events }`. |
| `calendar(link, { gate }).createEvent({ summary, start, end, timeZone?, attendees?, sendUpdates?, description?, location? }, { token? })` | Adds an event, after a foxgate approval. `timeZone` defaults to the browser time zone, and `sendUpdates` to `none`, so nobody gets an invite. The approval shows every field with its default. Returns `created`, `ask`, or `refused`. |
| `calendar(link, { gate }).patchEvent(id, changes, { token? })` | Changes the given fields of an event that the user organizes, after an approval. `start`, `end`, and `timeZone` go together. The approval also holds the current title, start, and end. Returns `updated`, `ask`, or `refused`. |
| `FOXLINK_TOOLS` | `foxlink.gmail.send`, `foxlink.gmail.draft`, `foxlink.calendar.create`, and `foxlink.calendar.update`, all with scope `submit`. Pass it to `createFoxgate({ tools })`, and add a `submit` grant for the API hosts. |

Refused reasons: `bad-input`, `missing-scope`, `no-gate`, `approval-required`,
`draft-only`, `not-own-event`, a `connect` error code such as `access-denied`, and every foxgate
deny reason, for example `action-changed`, `token-used`, or `rejected`.

### Text

| Export | What it does |
|---|---|
| `htmlToText(html)` | Plain text with no DOM and no network, in one pass. Scripts, styles, comments, and image URLs go away. Only a real close tag ends a script or style block. |
| `toPromptText(record)` | The record inside `<untrusted source="…" id="…">` tags. Its text cannot close the tag. |
| `decodeEntities(text)` | Decodes HTML entities one time. |
| `messageText(payload)` | The text of a Gmail message payload. |

Every message and event has `trust: "untrusted"` and a `source`. A tool such
as foxshield can then check the text before a model reads it.

### Errors

`FoxlinkError` has a `code`: `bad-config`, `bad-scope`, `busy`,
`authorize-failed`, `redirect-mismatch`, `state-mismatch`, `access-denied`,
`token-error`, `scope-creep`, `id-token`, `not-connected`, `reconnect`,
`unauthorized`, `bad-host`, `http-error`, `missing-scope`, or `bad-input`. It
can have `status` (HTTP) and `oauthError` (the server error code, cut to
`a-z 0-9 _`). No message holds a token, a code, or server text. Vault errors,
for example `locked`, come through as foxvault `VaultError`.

## Delivery/behavior limits

- We have not tested the real Google path. The tests use a fake Google
  server. We do not know yet if Google accepts the redirect URI
  `http://127.0.0.1/mozoauth2/<id>` with no port for a Desktop app client.
- foxlink does not check the ID token signature. It checks `nonce`, `aud`,
  and `iss` of an ID token that came straight from the token endpoint over
  TLS, as OpenID Connect Core 3.1.3.7 allows.
- `htmlToText` does not remove hidden text, for example text with
  `display: none`. Check the text with a tool such as foxshield.
- `getMessage` decodes every body as UTF-8. A body in another character
  set can show wrong characters.
- `connect` compares the granted scopes with the asked scopes as text. Use
  full scope URLs. A short name such as `email` comes back from Google as
  `https://www.googleapis.com/auth/userinfo.email`, and foxlink refuses it
  as `scope-creep`.
- The Google preset sends the access token to every request from the
  extension to `gmail.googleapis.com` and `www.googleapis.com`. The token
  scopes limit what those requests can do.
- `connect` does not revoke the tokens of an earlier connect. It replaces
  them in the vault.
- `sendMessage` takes bare addresses only, for example `ana@example.com`,
  not `Ana <ana@example.com>`.
- `sendMessage` sends a plain text body, with no HTML and no reply
  threading. The most it takes: 20 recipients, a body of 40,000 characters
  (the approval must fit in 64 KB), and 10 attachments of 3 MB together.
- `gmail.compose` lets the token send too. foxlink sends only after an
  approval, but other code with the token can send. The host must pass
  `privateMode`: foxlink does not know the run mode by itself.
- `listMessages` gets at most 50 messages for each call. It does not page
  through the whole mailbox by itself.
- `listEvents`, `createEvent`, and `patchEvent` use one calendar (`primary`
  by default). Events have no recurrence, reminders, or meeting links.
  foxlink cannot delete or cancel an event.
- One link object for each provider, in one background page. Two link
  objects on the same store do not share a refresh, so they can send two
  refresh requests at the same time.
- In passphrase mode, a locked vault stops every call with `locked`.
- Only the e2e build (`node scripts/build-ext.mjs --e2e`) has the host
  permission `http://*.localhost/*` and the local server port, for the fake
  Google. The release build that AMO signs has neither.

## Integration guides

- [Firefox Gmail and Google Calendar demo setup](#demo-extension)
- [Google OAuth client setup](#use-your-own-google-client-id)
- [Provider, vault, and scope configuration](#providers)

### Demo extension

`extension/` is the foxlink add-on for Firefox 153+. Type your OAuth client
ID in Settings. Then use "Connect Google", "Show my next 3 events", "Show 5
latest email subjects", and "Read the latest email". The first send asks
Google for the send scope. Then the popup shows To, Cc, Bcc, the subject,
the body, and each attachment, and it sends only after you approve. "Add an
event" works the same way, and sends invites only when you tick the box.

```bash
pnpm install
pnpm build:ext   # builds dist-ext/; load it from about:debugging
pnpm e2e         # builds with --e2e and runs it in Firefox against the local fake Google
```

### Use your own Google client ID

We have not tested foxlink with a real Google account. We tested it against
the fake Google server in `e2e/fake-google.mjs`, which copies the Google
endpoints and REST shapes. These are the steps to try the real Google:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project or select one.
2. In **APIs & Services > Library**, enable the **Gmail API** and the
   **Google Calendar API**.
3. Open **Google Auth Platform** (the OAuth consent screen). Set the
   audience to **External**. Add your own Google account as a test user.
4. In **Data Access**, add the scopes `gmail.readonly` and
   `calendar.readonly`. Add `gmail.send` only if you want to send, and
   `gmail.compose` only if you want drafts, and `calendar.events` only if
   you want to add events.
5. In **Clients**, create an OAuth client with the application type
   **Desktop app**. Google accepts loopback redirect URIs for this type.
   Copy the client ID and the client secret.
6. In the foxlink Settings, paste the client ID and the client secret.
   Select **Save**, then **Connect Google**.

Register the redirect URI returned by `link.redirectUri()` when your client type requires it.
The Google path needs a live check with your own client. Do not assume the fake server verifies Google acceptance.
See [Google OAuth for installed apps](https://developers.google.com/identity/protocols/oauth2/native-app).

## Status

The package version is 0.1.5. The 0.x API can change.
[GitHub issues](https://github.com/pooriaarab/foxlink/issues) are the support channel.
Public case studies are not yet published. Real Google accounts have not been verified by the repository tests.

## FAQ

### What is foxlink-oauth?

foxlink-oauth connects OAuth providers to trusted host code with foxvault token storage. It includes Gmail and Google Calendar clients.

### Which integrations are verified?

foxlink-oauth tests Google-shaped endpoints with a local fake server. The repository records no real-account credential verification.

### Does foxlink-oauth provide a managed OAuth service?

foxlink-oauth is a library you run in your extension or host process. You register and configure your own OAuth client.

### How is foxlink-oauth different from oauth4webapi?

foxlink-oauth includes vault storage and approval-gated Gmail and Calendar methods. oauth4webapi exposes general protocol routines; see the [comparison](#compare).

### How is foxlink-oauth different from Auth0 SPA SDK?

foxlink-oauth targets provider connections and extension service clients. Auth0 SPA SDK targets browser login for Auth0 applications; see the [comparison](#compare).

### Can an agent send email without approval?

foxlink-oauth requires a foxgate token for `sendMessage`. A changed action or used token is refused; ordinary drafts do not require approval.

### Does foxlink-oauth expose access tokens to the caller?

foxlink-oauth returns connection status without tokens. The `inject` transport delegates API headers to foxvault; `use` constructs headers in trusted host code.

### Does foxlink-oauth run in Node.js?

foxlink-oauth text helpers run in Node.js. OAuth connections outside Firefox need custom launch and redirect handling with the `use` transport.

### Does untrusted text become safe for an AI model?

foxlink-oauth marks records as untrusted and removes selected HTML elements. Hidden text can remain, so the host must enforce its own model-input policy.

## License

[MIT](https://opensource.org/license/mit)
