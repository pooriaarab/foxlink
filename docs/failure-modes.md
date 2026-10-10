# Failure modes

This file lists every way foxlink can fail. We wrote each list before the
code. Each row names the test that proves the wanted behaviour. Tests in
`tests/` run in Node with `pnpm test`, against the fake Google server in
`e2e/fake-google.mjs`. Checks named `E…` run in a real Firefox with
`pnpm e2e`, against the same fake server.

The fake server copies the Google endpoints that foxlink uses: the
authorize page, the token endpoint with PKCE checks, refresh, revoke, and
the Gmail and Calendar REST shapes. It is not Google. See the README for
what is not tested against the real Google.

## Connect (O)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| O1 | CSRF: the redirect comes back with a `state` that foxlink did not send. | `connect` throws `state-mismatch`. It sends no token request and stores nothing. | `connect.test.ts` O1 |
| O2 | The redirect comes back with no `state`. | `connect` throws `state-mismatch`. | `connect.test.ts` O2 |
| O3 | The URL that the browser returns does not start with the redirect URI that foxlink sent. | `connect` throws `redirect-mismatch`. It reads no code from that URL. | `connect.test.ts` O3 |
| O4 | PKCE: the authorize request has no `code_challenge`, uses `plain`, or the token request has no verifier or the wrong one. | The authorize URL has an S256 challenge of a 43-character verifier. The fake server refuses a token request without the matching verifier, so a connect that works proves the match. | `connect.test.ts` O4 |
| O5 | Two `connect` calls run at the same time and mix up their state and verifier. | The second call throws `busy`. The first call works. | `connect.test.ts` O5 |
| O6 | Redirect URI mismatch: the client does not have the redirect URI registered. | The authorize page refuses with `redirect_uri_mismatch`. `connect` throws `authorize-failed`. Nothing is stored. | `connect.test.ts` O6 |
| O7 | The token request sends a different `redirect_uri` than the authorize request. | foxlink sends the same value in both. The fake server refuses a different one. | `connect.test.ts` O4 |
| O8 | The user denies consent. | `connect` throws `access-denied`. Nothing is stored. | `connect.test.ts` O8 |
| O9 | An attacker puts HTML or a long text in `error` or `error_description`. | The error message holds only the error code, cut to `a-z`, `0-9`, and `_`. | `connect.test.ts` O9 |
| O10 | Scope creep from the server: the token response grants more scopes than foxlink asked for. | foxlink revokes the token, stores nothing, and throws `scope-creep`. | `connect.test.ts` O10 |
| O11 | Scope creep from the caller: `connect` asks for a scope that the provider config does not allow. | `connect` throws `bad-scope` before the browser opens a window. | `connect.test.ts` O11 |
| O12 | The user grants only part of the scopes (Google granular consent). | `connect` works. `status()` shows the granted scopes only. A call that needs a scope that is not granted gets `missing-scope`, with no request. | `connect.test.ts` O12, `gmail.test.ts` G1 |
| O13 | OpenID: the ID token has a different `nonce` or `aud`. | `connect` revokes the token, stores nothing, and throws `id-token`. | `connect.test.ts` O13 |
| O14 | A provider config uses `http:` for an endpoint, has no client ID, or has default scopes outside `allowedScopes`. | `googleProvider` and `defineProvider` throw `bad-config`. `http:` works only with `allowHttp` (for test servers only). | `provider.test.ts` O14 |
| O15 | The token response has no refresh token. | `connect` works. When the access token expires, calls throw `reconnect`. | `tokens.test.ts` T7 |
| O16 | The Google preset asks for a write scope by default. | The default scopes are `gmail.readonly` and `calendar.readonly`. Send and write scopes come only from `scopes` or `allowedScopes`. | `provider.test.ts` O16 |
| O17 | Google refuses the `*.extensions.allizom.org` redirect URL, because nobody can verify that domain. | The Google preset uses the Firefox loopback form `http://127.0.0.1/mozoauth2/<subdomain>`, made from `identity.getRedirectURL()`. | `provider.test.ts` O17 |

## Tokens (T)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | The access token expired by the local clock. | foxlink refreshes it one time before the call. | `tokens.test.ts` T1 |
| T2 | The server answers 401, but the local clock says that the token is fresh (clock skew, or the server dropped the token). | foxlink refreshes one time and tries the call again one time. A second 401 throws `unauthorized`. There is no loop. | `tokens.test.ts` T2 |
| T3 | Clock skew: the token expires within the next 60 seconds. | foxlink refreshes it before the call. | `tokens.test.ts` T3 |
| T4 | `expires_in` is missing, zero, negative, not a number, or very large. | foxlink keeps it between 60 seconds and 1 day. A missing or bad value counts as 300 seconds. | `tokens.test.ts` T4 |
| T5 | Refresh race: five calls start at the same time with an expired token. | foxlink sends one refresh request. All five calls work. | `tokens.test.ts` T5 |
| T6 | Refresh race after 401: two calls at the same time both get 401. | foxlink sends one refresh request. Both calls work. | `tokens.test.ts` T6 |
| T7 | The refresh token was revoked (`invalid_grant`). | foxlink forgets the tokens. The call throws `reconnect`. `status()` says not connected. | `tokens.test.ts` T7 |
| T8 | The token endpoint fails with a 5xx or a network error. | The call throws `token-error`. foxlink keeps the tokens, so a later call can refresh. | `tokens.test.ts` T8 |
| T9 | The refresh response has a new refresh token. | foxlink stores the new one. The next refresh uses it. | `tokens.test.ts` T9 |
| T10 | `disconnect` fails at the revoke endpoint. | foxlink still forgets every token and its record. The result says `revoked: false`. | `tokens.test.ts` T10 |
| T11 | A call before `connect`, or after `disconnect`. | It throws `not-connected`, with no request. | `tokens.test.ts` T11 |
| T12 | `link.fetch` gets a URL on a host that is not an API host, or `http:`. | It throws `bad-host` and sends no token. | `tokens.test.ts` T12 |
| T13 | The vault is locked (passphrase mode). | The call throws the vault error `locked`. foxlink sends no request. | `tokens.test.ts` T13 |
| T14 | `connect` runs while a refresh of the old grant is still running. The refresh ends later and writes the old token and the old scopes over the new ones. | A refresh that started before a `connect` or a `disconnect` throws its result away. The new scopes stay. | `tokens.test.ts` T14 |
| T15 | `disconnect` runs while a refresh is still running. The refresh ends later and writes a token back. | foxlink throws the late token away and stores nothing. The call throws `not-connected`. `status()` says not connected. | `tokens.test.ts` T15 |
| T16 | A short-lived token (`expires_in` of 60 seconds or less) is refreshed before every call, because the 60-second margin covers its whole life. | The margin is at most half of the token life. Two calls 10 seconds apart send no refresh. | `tokens.test.ts` T16 |

## Leaks (L)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| L1 | A token shows up in an error message. | No error message or error property holds an access token, a refresh token, a code, or the verifier. | `tokens.test.ts` L1 |
| L2 | A token is in the store (`storage.local` in Firefox) as plain text. | The store holds only foxvault ciphertexts and the token record (scopes and expiry). No token, code, or verifier. | `tokens.test.ts` L2, E5 |
| L3 | A token is in data that foxlink returns. | `status()`, the Gmail results, and the Calendar results hold no token. | `tokens.test.ts` L3 |
| L4 | foxlink writes a token to a log. | foxlink never calls `console`. | `tokens.test.ts` L4 |
| L5 | In Firefox, the page or the popup can read the access token. | The `inject` transport sends no `Authorization` header from foxlink code. foxvault adds it on the way out, for the API hosts only. | E3, E6 |

## Mail and events (M)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | An HTML email has `<script>`, `<style>`, or comments. | The text has none of their content. | `gmail.test.ts` M1 |
| M2 | An HTML email has a tracking pixel or a remote image. | The text has no image URL. foxlink never loads it. The fake server counts zero hits on the pixel. | `gmail.test.ts` M2, E7 |
| M3 | Entities: `&lt;script&gt;` or `&amp;lt;` in the HTML. | foxlink decodes each entity one time, to plain text. It does not parse the result again. | `gmail.test.ts` M3 |
| M4 | A multipart email (alternative inside mixed, with an attachment). | foxlink takes the `text/plain` part. With no `text/plain`, it converts the `text/html` part. It skips attachments. | `gmail.test.ts` M4 |
| M5 | The body is base64url with `-`, `_`, no padding, and UTF-8 characters. | The text is decoded correctly. | `gmail.test.ts` M4 |
| M6 | Email or event text has a prompt injection, for example "ignore your instructions". | Every message and event has `trust: "untrusted"`. `toPromptText` wraps the text in an `<untrusted>` block and breaks any `</untrusted>` inside it. | `gmail.test.ts` M6 |
| M7 | Header injection in send: `to` or `subject` has a CR or LF. | `sendMessage` refuses with `bad-input`. | `send.test.ts` S6 |
| M8 | A subject has non-ASCII characters. | The subject is RFC 2047 encoded. | `send.test.ts` S2 |
| M12 | An ASCII subject that looks like an RFC 2047 encoded word (`=?UTF-8?B?...?=`). The human approves the encoded text, and the mail client shows other words. | foxlink encodes such a subject too, so the recipient sees the exact text that the human approved. | `send.test.ts` M12 |
| M13 | A long non-ASCII subject becomes one encoded word of 2,000 characters, over the RFC 2047 limit of 75 and the RFC 5322 line limit of 998. | foxlink splits the subject into encoded words of 75 characters at most, on character boundaries, and folds the header. | `send.test.ts` M13 |
| M9 | A hostile HTML email (many unclosed quotes, `<script>` tags, or comments) makes the HTML to text step run for seconds, and the background page hangs. | `htmlToText` reads the HTML in one pass. 1 MB of hostile HTML takes less than 1 second. | `gmail.test.ts` M9 |
| M10 | A look-alike close tag such as `</scriptx>` or `</stylesheet>` ends the dropped block early, so script text that a browser never shows reaches the model. | Only a real close tag (`</script` then whitespace, `/`, or `>`) ends the block. | `gmail.test.ts` M10 |
| M11 | A `'` or `"` inside an unquoted attribute value (`<p title=it's>`) counts as a quote, and visible text after it is lost. The human and the agent then see different emails. | A quote opens a quoted value only right after `=`. | `gmail.test.ts` M11 |

## Calendar (C)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | `listEvents` returns past events, or too many. | It starts at `timeMin` (default: now), sorts by start time, and keeps `max` between 1 and 50. | `send.test.ts` C1 |
| C2 | An event description has HTML or a prompt injection. | The description is plain text, and the event has `trust: "untrusted"`. | `send.test.ts` C2 |
| C3 | No Calendar scope. | `listEvents` throws `missing-scope`, with no request. | `send.test.ts` C3 |

## Paging (P)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | A giant mailbox (10,000 messages). | `listMessages({ max: 5 })` sends one list request and five metadata requests. It returns `nextPageToken`. | `gmail.test.ts` P1 |
| P2 | `max` is very large, zero, or not a number. | foxlink keeps it between 1 and 50. | `gmail.test.ts` P2 |
| P3 | The caller passes the next page token. | The next call returns the next messages, with no repeat. | `gmail.test.ts` P3 |

## Gated writes (S)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | `sendMessage` or `createEvent` with no gate. | It refuses with `no-gate`. Nothing is sent. | `send.test.ts` S1 |
| S2 | The human cannot see what they approve. | The first call returns `ask`. The pending request text shows the exact `to`, `subject`, and `body`. | `send.test.ts` S2 |
| S3 | A token for message A is used to send message B. | It refuses with `action-changed`. Nothing is sent. | `send.test.ts` S3 |
| S4 | A token is used two times. | The second call refuses with `token-used`. One message is sent. | `send.test.ts` S4 |
| S5 | The human rejects the request. | The call refuses with `rejected`. | `send.test.ts` S5 |
| S6 | Bad input: no `to`, a bad address, an event that ends before it starts. | It refuses with `bad-input`, before the gate. | `send.test.ts` S6 |
| S7 | A write scope is not granted. | It refuses with `missing-scope`, before the gate. | `send.test.ts` S7 |

## Send and drafts (W)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| W1 | A send runs before the user granted `gmail.send`. | foxlink asks for consent one time, for the granted scopes plus `gmail.send`. Then the send asks foxgate. | `mail-write.test.ts` W1, E12 |
| W2 | The send scope is not in `allowedScopes`. | It refuses with `missing-scope`. No consent window opens. | `mail-write.test.ts` W2 |
| W3 | The user denies the extra consent. | It refuses with `access-denied`. The read grant still works. | `mail-write.test.ts` W3 |
| W4 | The host grant has `approval: "never"`, so foxgate allows a send with no human. | It refuses with `approval-required`. Nothing is sent. | `mail-write.test.ts` W4 |
| W5 | The approval hides a recipient or an attachment. | The approval text has `to`, `cc`, and `bcc` as lists (also when empty), the subject, the full body, and the name, type, size, and SHA-256 of each attachment. | `mail-write.test.ts` W5 |
| W6 | One byte of an attachment changes after the approval. | It refuses with `action-changed`. Nothing is sent. | `mail-write.test.ts` W6 |
| W7 | The caller changes the attachment bytes while the send runs. | foxlink copies the bytes at the start. Gmail gets the approved bytes. | `mail-write.test.ts` W7 |
| W8 | A CR or LF in `cc`, `bcc`, or a file name, or a bad MIME type. | It refuses with `bad-input`, before the gate. | `mail-write.test.ts` W8 |
| W9 | The message is too big for the gate (64 KB) or for Gmail. | A body over 40,000 characters, more than 20 recipients, more than 10 attachments, or more than 3 MB of attachments gets `bad-input`. | `mail-write.test.ts` W9 |
| W10 | The audit trail keeps the email text. | The foxtrail entry has the recipients, the Gmail ID, and the SHA-256 of the raw message. It has no subject, body, or attachment bytes. | `mail-write.test.ts` W10 |
| W11 | The trail write fails after Gmail took the message. | The result is `sent` with `logged: false`. foxlink does not send again. | `mail-write.test.ts` W11 |
| W12 | Draft-only mode sends an email. | `sendMessage` refuses with `draft-only` and asks for no send scope. `createDraft` saves a draft with no approval. | `mail-write.test.ts` W12 |
| W13 | A send runs while the run is in private-data mode. | It needs an approval with `privateData: true` in the text. A token from outside private-data mode gets `action-changed`. A draft asks too. | `mail-write.test.ts` W13 |
| E12 | In Firefox, the first send needs a scope that the user did not grant. | The send opens the consent window for `gmail.send`, then waits for approval. | `e2e/run.mjs` E12 |
| E13 | The body changes after the human approved. | The popup shows `refused: action-changed`. Nothing is sent. | `e2e/run.mjs` E13 |
| E14 | The agent sends a second time with the same token. | It refuses with `token-used`. The fake Gmail has one copy. | `e2e/run.mjs` E14 |

## Firefox (E)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | `identity.launchWebAuthFlow` cannot run against the loopback redirect `http://127.0.0.1/mozoauth2/…`. | The popup connects through the fake authorize page in an interactive window. | `e2e/run.mjs` E1 |
| E2 | The demo has no client ID. | Connect shows "Type your OAuth client ID first." and opens no window. | `e2e/run.mjs` E2 |
| E3 | The popup cannot list events and subjects. | It shows the next 3 events and the 5 latest subjects. | `e2e/run.mjs` E3 |
| E4 | The access token expires in Firefox. | The next list refreshes it and works. | `e2e/run.mjs` E4 |
| E5 | A token is in `storage.local`. | A dump of `storage.local` holds no token. | `e2e/run.mjs` E5 |
| E6 | A web page calls the API host and gets the token. | A request from a web page to the API host has no `Authorization` header. | `e2e/run.mjs` E6 |
| E7 | The popup loads the tracking pixel of an email. | The fake server counts zero pixel hits. | `e2e/run.mjs` E7 |
| E8 | A send runs with no approval. | Send asks first. Approve sends it one time. | `e2e/run.mjs` E8 |
| E9 | Disconnect leaves a token that works. | After disconnect, the fake server refuses the old refresh token. | `e2e/run.mjs` E9 |
| E10 | The release build keeps `http://*.localhost/*`, which only the fake Google uses. | The release `dist-ext/manifest.json` has only the Google hosts. The e2e build (`build-ext.mjs --e2e`) adds `*.localhost`. | `tests/build-ext.test.ts` E10 |
| E11 | The release build can still send OAuth codes and tokens to a local server, for example from a port saved by an e2e build. | The release bundle holds no `.localhost` endpoint, and the popup shows no local server field. | `tests/build-ext.test.ts` E11 |

## AMO release build and listed submission (`scripts/amo-listing.mjs`)

`pnpm check:amo` reads `dist-ext/`, which is what `release.yml` signs. Each
row is a way that the listed build or the submission can go wrong.

| ID | Failure | Wanted result |
|---|---|---|
| AR1 | `dist-ext/` is missing, so the check reads nothing | The check stops and says to run `pnpm build:ext` |
| AR2 | A content script in the release manifest matches `127.0.0.1`, `localhost` or `*.localhost` (a test bridge) | The check stops and names the pattern |
| AR3 | A host permission for a local host exists only for tests | The check stops, unless `local_hosts` in the listing gives a reason for that exact pattern |
| AR4 | A file named for tests (`e2e`, `fixture`, `test`, `spec`) is in `dist-ext/` | The check stops and names the file |
| AR5 | `dist-ext/` came from `build-ext.mjs --e2e` | AR2 or AR4 stops it |
| AR6 | The `local_hosts` reasons go to AMO as an unknown field | `metadata` leaves them out, as it does the privacy policy |
| AR7 | A re-run submits a version that AMO already has as listed | `version-status` says `listed`, and the step skips web-ext sign and finishes the release |
| AR8 | AMO has the version as unlisted | `version-status` stops and says to bump the version |
| AR9 | The AMO version lookup fails (401, 500, network) | `version-status` stops; it never guesses `absent` |
| AR10 | The add-on already exists on AMO, and the version lookup sends a parameter AMO refuses on a single version (400), so every release stops | `version-status` asks for `versions/v<version>/` with no query; an owner sees listed and unlisted versions there |

| ID | Failure | Wanted result |
|---|---|---|
| AR-U1 | A `local_hosts` reason for a host permission also clears a test content script on the same pattern | Each reason names its use (`host_permission`, `content_script`, `web_accessible_resource`, `externally_connectable`); a use without its own reason stops the check |
| AR-U2 | `local_hosts` keeps a reason for a use that the release build does not have | The check stops and names the pattern and the use |
