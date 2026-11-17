import { describe, expect, it } from "bun:test";
import { classifyGoogleConnectError, describeGoogleConnectError } from "../connectErrors.ts";
import type { GoogleConnectErrorCode } from "../rpc/schema.ts";

describe("Google connect error mapping", () => {
  // The first column is what GoogleService actually throws (or the token endpoint's own error inside it).
  const cases: [string, GoogleConnectErrorCode][] = [
    ["Google authorization failed: access_denied", "accessDenied"],
    ["The Google OAuth callback redirect URI did not match the pending authorization request.", "redirectUriMismatch"],
    ["exchange Google auth code for me@example.com failed: redirect_uri_mismatch", "redirectUriMismatch"],
    ["exchange Google auth code for me@example.com failed: invalid_client", "wrongClient"],
    ["exchange Google auth code for me@example.com failed: unauthorized_client", "wrongClient"],
    ["exchange Google auth code for me@example.com failed: client_secret is missing.", "wrongClient"],
    ["exchange Google auth code for me@example.com failed: invalid_grant", "invalidGrant"],
    ["exchange Google auth code for me@example.com failed: Vault is uninitialized or locked", "vaultLocked"],
    ["The vault is locked. Unlock it to save the token.", "vaultLocked"],
    ["exchange Google auth code for me@example.com failed: socket hang up", "exchangeFailed"],
    ["Something nobody has seen before", "unknown"],
  ];

  for (const [text, code] of cases) {
    it(`maps "${text}" to ${code}`, () => {
      expect(classifyGoogleConnectError(text)).toBe(code);
      const described = describeGoogleConnectError(new Error(text));
      expect(described.code).toBe(code);
      expect(described.details).toBe(text);
      expect(described.tryThis.length).toBeGreaterThan(0);
    });
  }

  it("shows an unknown error verbatim and with details to copy", () => {
    const described = describeGoogleConnectError(new Error("Something nobody has seen before"));
    expect(described.message).toBe("Something nobody has seen before");
    expect(described.details).toBe("Something nobody has seen before");
  });

  it("removes credentials from the text it returns", () => {
    const described = describeGoogleConnectError(new Error("failed with GOCSPX-abc123"), text => text.replaceAll("GOCSPX-abc123", "[hidden]"));
    expect(JSON.stringify(described)).not.toContain("GOCSPX-abc123");
    expect(described.details).toContain("[hidden]");
  });

  it("uses a forced code for conditions the wizard raises itself", () => {
    expect(describeGoogleConnectError(new Error("Timed out"), undefined, "timedOut").code).toBe("timedOut");
  });
});
