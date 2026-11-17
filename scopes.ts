import type { GoogleService as GoogleServiceName } from "./rpc/schema.ts";

/** Lets TokenRing read which email address signed in. Always asked for. */
export const GOOGLE_USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

/** What each Google service is allowed to do, as the scopes Google is asked for. Nothing is requested for a service that was not chosen. */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleServiceName, readonly string[]> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
  ],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  drive: ["https://www.googleapis.com/auth/drive"],
};

/** The scopes to request for exactly these services, plus the identity scope. */
export function scopesForServices(services: Iterable<GoogleServiceName>): string[] {
  const scopes = new Set<string>([GOOGLE_USERINFO_SCOPE]);
  for (const service of services) for (const scope of GOOGLE_SERVICE_SCOPES[service]) scopes.add(scope);
  return [...scopes];
}
