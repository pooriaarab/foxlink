export { FoxlinkError, type FoxlinkErrorCode } from "./errors.js";
export {
  GOOGLE_ENDPOINTS,
  GOOGLE_SCOPES,
  defineProvider,
  googleProvider,
  loopbackRedirectUrl,
  type GoogleEndpoints,
  type Provider,
  type ProviderConfig,
  type ProviderOptions,
} from "./provider.js";
export { createLink, type IdentityLike, type Link, type LinkOptions, type LinkStatus } from "./link.js";
export { gmail, messageText, type Gmail, type Message, type MessageSummary, type OutgoingMessage } from "./gmail.js";
export { decodeEntities, htmlToText, toPromptText, type Untrusted } from "./text.js";
export { calendar, type Calendar, type CalendarEvent, type NewEvent } from "./calendar.js";
export { FOXLINK_TOOLS } from "./gated.js";
