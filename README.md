# foxlink

<p align="center">Connect Gmail and Google Calendar to a Firefox extension with OAuth.</p>

<p align="center">
  <a href="https://github.com/pooriaarab/foxlink/actions"><img src="https://github.com/pooriaarab/foxlink/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT"/></a>
</p>

foxlink runs the OAuth 2.0 authorization code flow with PKCE through
`identity.launchWebAuthFlow`. It works with any provider config, and it has
a Google preset for Gmail and Calendar. The tokens go into
[foxvault](https://github.com/pooriaarab/foxvault). With the `inject`
transport, foxvault adds the access token to each API request in Firefox.
Then your extension code, the page, and the AI model never get the token. Sending an email or adding an event
waits for a [foxgate](https://github.com/pooriaarab/foxgate) approval of
the exact action. Email and event text comes back marked as untrusted.

You bring your own OAuth client ID. foxlink ships none.

## Install

```bash
npm i foxlink-oauth
```

The npm package is `foxlink-oauth`: npm refuses the plain name `foxlink` as too similar to an existing package (oxlint and comlink).


foxlink needs `foxvault` and `foxgate`. npm installs them with it.

## Example

This code runs in the background script of a Firefox extension. The
extension needs the permissions `identity`, `storage`, `webRequest`, and
`webRequestBlocking`, and host permissions for the Google hosts. The demo in
`extension/` makes the same calls.

```js
import { storageAreaStore } from "foxgate";
import { attachHeaderInjection, createVault, indexedDbKeyStore } from "foxvault";
import { calendar, createLink, gmail, googleProvider } from "foxlink-oauth";

const store = storageAreaStore(browser.storage.local);
const vault = createVault({ store, keyStore: indexedDbKeyStore() });
attachHeaderInjection(vault, browser); // at the top level of the event page

const provider = googleProvider({ clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com" });
const link = createLink({ provider, vault, store, identity: browser.identity, transport: "inject" });

// Call this from a message handler, for example when the user selects a button.
async function today() {
  if ((await vault.status()) === "new") await vault.initialize();
  if (!(await link.status()).connected) await link.connect(); // opens the Google sign-in window
  const { events } = await calendar(link).listEvents({ max: 3 });
  const { messages } = await gmail(link).listMessages({ max: 5 });
  return { events: events.map((e) => e.summary), subjects: messages.map((m) => m.subject) };
}
```

The HTML to text function also runs in Node:

```js
import { htmlToText } from "foxlink-oauth";

console.log(htmlToText('<p>Hi &amp; welcome</p><img src="https://t.example/p.gif"><script>steal()</script>'));
// Hi & welcome
```

## Use cases

| Who | What they build | How foxlink helps |
|---|---|---|
| A browser agent author (for example foxmate) | An agent that reads the user's inbox and calendar and drafts replies | The agent gets message text marked `untrusted`, and never a token. A send waits for the user to approve the exact `to`, `subject`, and `body`. |
| An extension author | A "what is next today" popup or new tab page | `listEvents({ max: 3 })` with the read-only Calendar scope, and refresh on expiry with no code of your own. |
| A privacy tool author | An inbox cleaner that runs on the user's device only | The mail goes from Google to the extension and nowhere else. `htmlToText` drops scripts and tracking pixels, so opening a message loads nothing. |
| An author of another OAuth integration | A link to GitHub, Notion, or any provider that issues codes with PKCE | `defineProvider` takes the endpoints, scopes, and API hosts. `connect`, `fetch`, refresh, and `disconnect` work the same. |
| An MCP server or agent framework author | An email or calendar tool for a model | `gmail` and `calendar` return small typed records. `toPromptText` fences each record so that its text cannot close the fence. |
| A security reviewer | A check that an extension asks only for what it needs | The Google preset asks for read-only scopes. `connect` refuses scopes outside the config and scopes that the server adds. |

## How it works

```mermaid
sequenceDiagram
  participant App as Your background script
  participant L as foxlink
  participant F as Firefox identity
  participant G as Google
  participant V as foxvault
  App->>L: connect()
  L->>L: make verifier, S256 challenge, state, and nonce (openid only)
  L->>F: launchWebAuthFlow(authorize URL with challenge and state)
  F->>G: sign-in and consent window
  G-->>F: redirect to http://127.0.0.1/mozoauth2/<id>?code&state
  F-->>L: redirect URL (Firefox does not load it)
  L->>L: check the redirect URI and the state
  L->>G: POST /token with code, redirect_uri, code_verifier
  G-->>L: access token, refresh token, granted scopes
  L->>L: refuse scopes that it did not ask for (revoke)
  L->>V: store both tokens encrypted, add a header rule for the API hosts
  L-->>App: status: connected, scopes, expiry (no token)
```

1. `connect` makes a 43-character PKCE verifier and sends its SHA-256
   challenge. It sends a random `state`, and a `nonce` when the scopes hold
   `openid`.
2. The redirect URL must have the same origin and path as the redirect URI,
   and the same `state`. Else foxlink reads no code from it.
3. When the server grants a scope that foxlink did not ask for, foxlink
   revokes the token and stores nothing.
4. The access token and the refresh token are foxvault secrets. The store
   holds only the scopes, the issue and expiry times, and whether a refresh
   token exists.
5. `link.fetch` sends requests to the API hosts only. It refreshes the
   access token 60 seconds before expiry (or at half its life, when that is
   sooner) and one time after a 401. Calls at the same time share one
   refresh request. A refresh that a `connect` or a `disconnect` overtook
   throws its token away.
6. When Google refuses the refresh token (`invalid_grant`), foxlink forgets
   the tokens and throws `reconnect`.

```mermaid
sequenceDiagram
  participant P as AI planner
  participant M as gmail(link, { gate })
  participant G as foxgate
  participant U as Human
  participant API as Gmail API
  P->>M: sendMessage({ to, subject, body })
  M->>M: check input (no CR or LF) and the send scope
  M->>G: check(foxlink.gmail.send, scope submit)
  G-->>M: ask, requestId
  M-->>P: { status: "ask", requestId }
  U->>G: approve the exact JSON (host side)
  G-->>P: token
  P->>M: sendMessage(same message, { token })
  M->>G: redeem(token, action)
  G-->>M: allow, the judged args
  M->>API: POST messages/send (foxvault adds the token)
  M-->>P: { status: "sent", id }
```

A changed message gets `action-changed`, and a used token gets
`token-used`. Every failure mode has a test: see
[docs/failure-modes.md](docs/failure-modes.md).

## API

This package is a library only. It has no CLI and no MCP server. The tokens
must stay in one extension, behind foxvault. A CLI or an MCP server would
have to hold the tokens in another process.

### Providers

| Export | What it does |
|---|---|
| `googleProvider({ clientId, clientSecret?, scopes?, allowedScopes?, endpoints?, allowHttp? })` | The Google preset. Default scopes: `gmail.readonly` and `calendar.readonly`. `allowedScopes` is the most that `connect` may ask for. It uses the loopback redirect and asks for offline access. |
| `defineProvider(config)` | Any provider. `config` has `id`, `clientId`, `authorizeUrl`, `tokenUrl`, `revokeUrl?`, `scopes`, `allowedScopes?`, `apiHosts`, `authParams?`, `redirect?` (`"extension"` or `"loopback"`), `issuers?`, and `allowHttp?`. |
| `GOOGLE_SCOPES` | `gmailRead`, `gmailSend`, `calendarRead`, and `calendarEvents`. |
| `GOOGLE_ENDPOINTS` | The Google authorize, token, revoke, Gmail, and Calendar URLs. |
| `loopbackRedirectUrl(url)` | `http://127.0.0.1/mozoauth2/<subdomain>` from the value of `identity.getRedirectURL()`. |

`allowHttp` is for test servers only. Without it, every endpoint must use
`https:`.

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
| `gmail(link, { gate }).sendMessage({ to, subject, body }, { token? })` | A plain text email, after a foxgate approval. A subject with non-ASCII characters or `=?` goes out as RFC 2047 encoded words, so the recipient sees the approved text. Returns `{ status: "sent", id }`, `{ status: "ask", requestId }`, or `{ status: "refused", reason }`. |
| `calendar(link).listEvents({ timeMin?, timeMax?, max? })` | The next events from `timeMin` (default: now), by start time. Returns `{ events }`. |
| `calendar(link, { gate }).createEvent({ summary, start, end, description?, location? }, { token? })` | Adds an event, after a foxgate approval. Returns `created`, `ask`, or `refused`. |
| `FOXLINK_TOOLS` | `{ "foxlink.gmail.send": "submit", "foxlink.calendar.create": "submit" }`. Pass it to `createFoxgate({ tools })`, and add a `submit` grant for the API hosts. |

Refused reasons: `bad-input`, `missing-scope`, `no-gate`, and every foxgate
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

## Demo extension

`extension/` is a demo for Firefox 153+. Type your OAuth client ID in
Settings. Then use "Connect Google", "Show my next 3 events", "Show 5 latest
email subjects", and "Read the latest email". With "Ask for the Gmail send
scope" on, you can send an email after you approve the exact message.

```bash
pnpm install
pnpm build:ext   # builds dist-ext/; load it from about:debugging
pnpm e2e         # runs the demo in Firefox against the local fake Google
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
   `calendar.readonly`. Add `gmail.send` only if you want to send.
5. In **Clients**, create an OAuth client with the application type
   **Desktop app**. Google accepts loopback redirect URIs for this type.
   Copy the client ID and the client secret.
6. In the demo Settings, paste the client ID and the client secret. Leave
   the test server port empty. Select **Save**, then **Connect Google**.

If Google refuses the redirect URI, make a **Web application** client
instead. Add the redirect URI that the demo Settings show under
**Authorized redirect URIs**. Google treats the client secret of an
installed app as not secret. foxlink sends it to the token endpoint only.

While the app is in the **Testing** state, Google makes refresh tokens that
expire in 7 days. Then the demo asks you to connect again. `gmail.readonly`
is a restricted scope. A public app with it needs a Google review.

## Firefox APIs used

| API | MDN | Why |
|---|---|---|
| `identity.launchWebAuthFlow` (permission `identity`) | [launchWebAuthFlow](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow) | Open the sign-in window and get the redirect URL with the code. |
| `identity.getRedirectURL` | [getRedirectURL](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/getRedirectURL) | The stable redirect URL from the add-on ID. The Google preset turns it into the loopback form. |
| Loopback redirect `http://127.0.0.1/mozoauth2/<subdomain>` (Firefox 86+) | [identity](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity) | Google refuses the `extensions.allizom.org` domain, because nobody can verify it. |
| Web Crypto `subtle.digest` and `crypto.getRandomValues` | [digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest) | The PKCE verifier and challenge, the state, and the nonce. |
| `fetch` | [fetch](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch) | The token, revoke, Gmail, and Calendar requests. |
| `webRequest.onBeforeSendHeaders` with `blocking`, through foxvault | [onBeforeSendHeaders](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onBeforeSendHeaders) | foxvault adds the access token to requests from the extension to the API hosts. |
| IndexedDB, through foxvault | [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) | The non-extractable vault key. |
| `storage.local` | [storage.local](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local) | Encrypted tokens, the token record, foxgate state, and demo settings. |
| `runtime.sendMessage`, `runtime.onMessage` | [runtime](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime) | The popup talks to the background page. Demo only. |

## Limits

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
- `sendMessage` sends plain text only. It has no HTML, no attachments, no
  CC or BCC, and no reply threading.
- `listMessages` gets at most 50 messages for each call. It does not page
  through the whole mailbox by itself.
- `listEvents` reads one calendar (`primary` by default).
- One link object for each provider, in one background page. Two link
  objects on the same store do not share a refresh, so they can send two
  refresh requests at the same time.
- In passphrase mode, a locked vault stops every call with `locked`.
- The demo has a host permission for `http://*.localhost/*`, for the E2E
  test server.

## Part of the fox primitives

```mermaid
flowchart LR
  foxkit[foxkit] -- template --> foxlink[foxlink]
  foxvault[foxvault] --> foxlink
  foxgate[foxgate] --> foxlink
  foxgate --> foxvault
  foxlink --> foxmate[foxmate]
  foxlink -. untrusted text .-> foxshield[foxshield]
  click foxkit "https://github.com/pooriaarab/foxkit"
  click foxvault "https://github.com/pooriaarab/foxvault"
  click foxgate "https://github.com/pooriaarab/foxgate"
  click foxlink "https://github.com/pooriaarab/foxlink"
  click foxmate "https://github.com/pooriaarab/foxmate"
  click foxshield "https://github.com/pooriaarab/foxshield"
```

foxlink depends on foxvault for the tokens and on foxgate for approvals.
foxshield does not depend on foxlink. An app can pass foxlink text to
foxshield before a model reads it.

## License

[MIT](LICENSE)
