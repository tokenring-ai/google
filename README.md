# @tokenring-ai/google

## Overview

`@tokenring-ai/google` provides Google OAuth account management plus concrete Google-backed providers for other abstract Token Ring packages.

Current integrations:

- `GoogleService` for OAuth token handling and authenticated Google API access
- `GmailEmailProvider` for `@tokenring-ai/email`
- `GoogleCalendarProvider` for `@tokenring-ai/calendar`
- `GoogleDriveFileSystemProvider` for `@tokenring-ai/filesystem`

The package follows the same extension pattern as other provider packages in the repository: it does not replace the abstract services, it registers concrete providers into them.

## Installation

```bash
bun install
```

Typical application usage:

```ts
import GooglePlugin from "@tokenring-ai/google/plugin";
```

## Features

- Centralized Google OAuth account configuration
- Authorization URL generation for Google OAuth flows
- Authorization code exchange and refresh-token support
- Authenticated Google API access through `GoogleService`
- Gmail provider registration for the email package
- Google Calendar provider registration for the calendar package
- Google Drive filesystem provider registration for the filesystem package

## Core Components

### `GoogleService`

Main service for Google OAuth and authenticated HTTP requests.

```ts
class GoogleService implements TokenRingService {
  getAvailableAccounts(): string[];
  getDefaultAccountName(): string | undefined;
  getAccount(name?: string): GoogleAccount;
  getUserEmail(name?: string): string;
  createAuthorizationUrl(name?: string, options?: AuthorizationOptions): string;
  exchangeAuthorizationCode(name: string, code: string): Promise<GoogleAccount>;
  refreshAccessToken(name?: string): Promise<string>;
  getAccessToken(name?: string): Promise<string>;
  fetchGoogleJson<T>(name: string | undefined, url: string, init: RequestInit, context: string): Promise<T>;
  fetchGoogleRaw(name: string | undefined, url: string, init: RequestInit, context: string): Promise<Response>;
}
```

### `GmailEmailProvider`

Concrete `EmailProvider` implementation for Gmail.

Capabilities:

- list inbox messages
- search messages
- select current message
- create and update drafts
- send the current draft

### `GoogleCalendarProvider`

Concrete `CalendarProvider` implementation for Google Calendar.

Capabilities:

- list upcoming events
- search events
- select current event
- create events
- update the current event
- delete the current event

### `GoogleDriveFileSystemProvider`

Concrete `FileSystemProvider` implementation for Google Drive.

Capabilities:

- list directories
- read files
- write and append files
- rename and move files
- copy files
- create folders
- delete files
- stat and existence checks

Unsupported filesystem operations:

- `glob`
- `grep`
- `watch`

These are intentionally unsupported because the Drive API does not provide equivalent behavior to the local filesystem providers.

## Usage Examples

### Plugin Installation

```ts
import TokenRingApp from "@tokenring-ai/app";
import GooglePlugin from "@tokenring-ai/google/plugin";

const app = new TokenRingApp();
app.usePlugin(GooglePlugin, {
  google: {
    defaultAccount: "primary",
    accounts: {
      primary: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: "http://localhost:3000/oauth/google/callback",
        userEmail: "me@example.com",
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      },
    },
  },
});
```

### Programmatic OAuth Usage

```ts
import {GoogleService} from "@tokenring-ai/google";

const googleService = app.requireService(GoogleService);

const authorizationUrl = googleService.createAuthorizationUrl("primary");
const updatedAccount = await googleService.exchangeAuthorizationCode("primary", "AUTH_CODE");
const accessToken = await googleService.getAccessToken("primary");
```

### Email Integration Example

```ts
{
  email: {
    agentDefaults: {
      provider: "gmail"
    },
    providers: {
      gmail: {
        type: "gmail",
        description: "Primary Gmail inbox",
        account: "primary"
      }
    }
  }
}
```

### Calendar Integration Example

```ts
{
  calendar: {
    agentDefaults: {
      provider: "google-calendar"
    },
    providers: {
      "google-calendar": {
        type: "google-calendar",
        description: "Primary Google Calendar",
        account: "primary",
        calendarId: "primary"
      }
    }
  }
}
```

### Filesystem Integration Example

```ts
{
  filesystem: {
    agentDefaults: {
      provider: "gdrive",
      selectedFiles: []
    },
    providers: {
      gdrive: {
        type: "google-drive",
        description: "Primary Google Drive root",
        account: "primary",
        rootFolderId: "root"
      }
    }
  }
}
```

## Configuration

The package is configured under the `google` key, and optionally under the abstract package keys it extends.

```ts
{
  google: {
    defaultAccount: "primary",
    accounts: {
      primary: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        redirectUri: "http://localhost:3000/oauth/google/callback",
        userEmail: "me@example.com",
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        accessToken: process.env.GOOGLE_ACCESS_TOKEN,
        expiryDate: 0,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar"
        ]
      }
    }
  }
}
```

### Schemas

- `GoogleConfigSchema`
  - `accounts: Record<string, GoogleAccount>`
  - `defaultAccount?: string`
- `GoogleAccountSchema`
  - `clientId: string`
  - `clientSecret: string`
  - `redirectUri: string`
  - `userEmail: string`
  - `refreshToken?: string`
  - `accessToken?: string`
  - `expiryDate?: number`
  - `scopes: string[]`
- `GmailEmailProviderOptionsSchema`
- `GoogleCalendarProviderOptionsSchema`
- `GoogleDriveFileSystemProviderOptionsSchema`

## Integration

The plugin integrates with abstract Token Ring services rather than registering new tools or commands directly.

It can register:

- `GoogleService`
- Gmail providers into `EmailService`
- Google Calendar providers into `CalendarService`
- Google Drive providers into `FileSystemService`

This means `@tokenring-ai/google` is typically used alongside:

- `@tokenring-ai/email`
- `@tokenring-ai/calendar`
- `@tokenring-ai/filesystem`

## State Management

`GoogleService` keeps account token updates in memory at runtime.

Important behavior:

- refreshed access tokens are stored in the service instance
- refresh tokens returned during code exchange are also kept in memory
- provider-specific state, such as current Gmail message, current Gmail draft, or current calendar event, is stored in provider-local agent state slices
- token persistence is intentionally left to the integrating application

## Best Practices

- Configure a stable `defaultAccount` when most providers use the same Google identity.
- Persist refreshed credentials outside the service if long-lived operation matters.
- Limit provider scopes to what the application needs when possible.
- Treat Google Drive as an API-backed virtual filesystem, not a drop-in POSIX replacement.

## Dependencies

Key runtime dependencies:

- `@tokenring-ai/agent`
- `@tokenring-ai/app`
- `@tokenring-ai/calendar`
- `@tokenring-ai/email`
- `@tokenring-ai/filesystem`
- `@tokenring-ai/utility`
- `zod`

## License

MIT License - see [LICENSE](/home/mdierolf/gitprojects/tokenring/pkg/google/LICENSE).
