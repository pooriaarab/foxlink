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
