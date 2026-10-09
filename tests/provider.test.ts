// Failure modes O14, O16, and O17 in docs/failure-modes.md: provider configs.
import { describe, expect, it } from "vitest";
import { GOOGLE_SCOPES, defineProvider, googleProvider, loopbackRedirectUrl } from "../src/index.js";

const generic = {
  id: "example",
  clientId: "client-1",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["read"],
  apiHosts: ["api.example.com"],
};
const badConfig = expect.objectContaining({ code: "bad-config" });

describe("provider config", () => {
  it("O14: http endpoints need allowHttp", () => {
    const local = { authorizeUrl: "http://accounts.localhost:8080/auth", tokenUrl: "http://oauth2.localhost:8080/token" };
    expect(() => googleProvider({ clientId: "c", endpoints: local })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, tokenUrl: "http://auth.example.com/token" })).toThrow(badConfig);
    expect(googleProvider({ clientId: "c", endpoints: local, allowHttp: true }).tokenUrl).toBe("http://oauth2.localhost:8080/token");
    expect(() => googleProvider({ clientId: "c", endpoints: { gmailBase: "http://gmail.localhost/gmail/v1" } })).toThrow(badConfig);
  });

  it("O14: a missing client ID, bad scopes, or bad hosts throw bad-config", () => {
    expect(() => googleProvider({ clientId: "" })).toThrow(badConfig);
    expect(() => googleProvider({ clientId: "has space" })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, scopes: [] })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, scopes: ["a b"] })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, scopes: ["read", "write"], allowedScopes: ["read"] })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, apiHosts: [] })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, apiHosts: ["https://api.example.com"] })).toThrow(badConfig);
    expect(() => defineProvider({ ...generic, id: "Bad ID" })).toThrow(badConfig);
  });

  it("O14: a provider config is frozen", () => {
    const provider = defineProvider(generic);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider.allowedScopes).toEqual(["read"]);
    expect(provider.redirect).toBe("extension");
  });

  it("O16: the Google preset is read-only by default", () => {
    const google = googleProvider({ clientId: "c" });
    expect(google.scopes).toEqual([GOOGLE_SCOPES.gmailRead, GOOGLE_SCOPES.calendarRead]);
    expect(google.allowedScopes).toEqual(google.scopes);
    expect(google.apiHosts).toEqual(["gmail.googleapis.com", "www.googleapis.com"]);
    expect(google.authParams).toMatchObject({ access_type: "offline", prompt: "consent" });
    const write = googleProvider({ clientId: "c", allowedScopes: [...google.scopes, GOOGLE_SCOPES.gmailSend] });
    expect(write.scopes).toEqual(google.scopes);
    expect(write.allowedScopes).toContain(GOOGLE_SCOPES.gmailSend);
  });

  it("O17: the Google preset uses the Firefox loopback redirect", () => {
    expect(googleProvider({ clientId: "c" }).redirect).toBe("loopback");
    expect(loopbackRedirectUrl("https://63cdfddeabf6191e9278f69e9869e8d15bfa6132.extensions.allizom.org/")).toBe(
      "http://127.0.0.1/mozoauth2/63cdfddeabf6191e9278f69e9869e8d15bfa6132",
    );
    expect(() => loopbackRedirectUrl("not a url")).toThrow();
  });
});
