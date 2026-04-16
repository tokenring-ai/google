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

**Implements:** `TokenRingService`

**Methods:**

```ts
class GoogleService implements TokenRingService {
  readonly name: string;
  readonly description: string;

  constructor(options: GoogleConfig);

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

**Method Details:**

- `getAvailableAccounts()`: Returns list of configured account names
- `getDefaultAccountName()`: Returns the configured default account name, or undefined
- `getAccount(name?)`: Returns the account configuration, throws if not found
- `getUserEmail(name?)`: Returns the email address for the account
- `createAuthorizationUrl(name?, options?)`: Generates OAuth authorization URL with configurable scopes, state, access type, and prompt
- `exchangeAuthorizationCode(name, code)`: Exchanges OAuth code for tokens, updates account with refresh token and access token
- `refreshAccessToken(name?)`: Refreshes expired access token using refresh token
- `getAccessToken(name?)`: Returns valid access token, refreshing if necessary
- `fetchGoogleJson(name, url, init, context)`: Makes authenticated request and parses JSON response
- `fetchGoogleRaw(name, url, init, context)`: Makes authenticated request and returns raw Response

**Authorization Options:**

```ts
type AuthorizationOptions = {
  state?: string;
  scopes?: string[];
  accessType?: "offline" | "online";
  prompt?: "consent" | "none" | "select_account";
  loginHint?: string;
};
```

### `GmailEmailProvider`

Concrete `EmailProvider` implementation for Gmail.

**Implements:** `EmailProvider`

**Capabilities:**

- List inbox messages with filtering (unread/read)
- Search messages with query and filtering
- Select specific message by ID
- Create and update drafts
- Send the current draft

**Methods:**

```ts
class GmailEmailProvider implements EmailProvider {
  readonly description: string;

  constructor(options: GmailEmailProviderOptions, googleService: GoogleService);

  getInboxMessages(filter: EmailInboxFilterOptions, agent: Agent): Promise<EmailMessage[]>;
  searchMessages(filter: EmailSearchOptions, agent: Agent): Promise<EmailMessage[]>;
  getMessageById(id: string, agent: Agent): Promise<EmailMessage>;
  createDraft(data: DraftEmailData, agent: Agent): Promise<EmailDraft>;
  updateDraft(data: EmailDraft, agent: Agent): Promise<EmailDraft>;
  sendDraft(id: string, agent: Agent): Promise<void>;
}
```

**Supported Operations:**

- `getInboxMessages()`: Lists messages from inbox with optional unread filter
- `searchMessages()`: Searches messages with query string and optional unread filter
- `getMessageById()`: Fetches full message content by ID
- `createDraft()`: Creates a new draft with to, cc, bcc, subject, and body
- `updateDraft()`: Updates an existing draft
- `sendDraft()`: Sends the draft by ID

### `GoogleCalendarProvider`

Concrete `CalendarProvider` implementation for Google Calendar.

**Implements:** `CalendarProvider`

**Capabilities:**

- List upcoming events with time range filtering
- Search events with query and time range
- Select specific event by ID
- Create events
- Update the current event
- Delete the current event

**Methods:**

```ts
class GoogleCalendarProvider implements CalendarProvider {
  readonly description: string;

  constructor(options: GoogleCalendarProviderOptions, googleService: GoogleService);

  getUpcomingEvents(filter: CalendarEventFilterOptions, agent: Agent): Promise<CalendarEvent[]>;
  searchEvents(filter: CalendarEventSearchOptions, agent: Agent): Promise<CalendarEvent[]>;
  createEvent(data: CreateCalendarEventData, agent: Agent): Promise<CalendarEvent>;
  updateEvent(id: string, data: UpdateCalendarEventData, agent: Agent): Promise<CalendarEvent>;
  selectEventById(id: string, agent: Agent): Promise<CalendarEvent>;
  deleteEvent(id: string, agent: Agent): Promise<void>;
}
```

**Supported Operations:**

- `getUpcomingEvents()`: Lists upcoming events from the calendar with time range and limit
- `searchEvents()`: Searches events by query string within time range
- `createEvent()`: Creates a new event with title, description, location, attendees, and timing
- `updateEvent()`: Updates an existing event by ID
- `selectEventById()`: Fetches a specific event by ID
- `deleteEvent()`: Deletes an event by ID

### `GoogleDriveFileSystemProvider`

Concrete `FileSystemProvider` implementation for Google Drive.

**Implements:** `FileSystemProvider`

**Capabilities:**

- List directories with tree generation
- Read files
- Write and append files
- Rename and move files
- Copy files
- Create folders
- Delete files
- Stat and existence checks

**Methods:**

```ts
class GoogleDriveFileSystemProvider implements FileSystemProvider {
  readonly name: string;
  readonly description: string;

  constructor(options: GoogleDriveFileSystemProviderOptions, googleService: GoogleService);

  writeFile(filePath: string, content: string | Buffer): Promise<boolean>;
  appendFile(filePath: string, content: string | Buffer): Promise<boolean>;
  deleteFile(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<Buffer | null>;
  rename(oldPath: string, newPath: string): Promise<boolean>;
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<StatLike>;
  createDirectory(dirPath: string, options?: {recursive?: boolean}): Promise<boolean>;
  copy(source: string, destination: string, options?: {overwrite?: boolean}): Promise<boolean>;
  getDirectoryTree(path: string, params?: DirectoryTreeOptions): AsyncGenerator<string>;
}
```

**Unsupported filesystem operations:**

The following methods throw errors because the Drive API does not provide equivalent behavior to local filesystem providers:

- `glob()` - Pattern-based file matching not supported
- `watch()` - File system watching not supported
- `grep()` - Content search across files not supported

## Usage Examples

### Plugin Installation

```ts
import TokenRingApp from "@tokenring-ai/app";
import GooglePlugin from "@tokenring-ai/google/plugin";

const app = new TokenRingApp();
app.usePlugin(GooglePlugin, {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    defaultAccount: "primary",
    accounts: {
      primary: {
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
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    defaultAccount: "primary",
    accounts: {
      primary: {
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
  - `clientId: string`
  - `clientSecret: string`
  - `accounts: Record<string, GoogleAccount>`
  - `defaultAccount?: string`
- `GoogleAccountSchema`
  - `redirectUri: string`
  - `userEmail: string`
  - `refreshToken?: string`
  - `accessToken?: string`
  - `expiryDate?: number`
  - `scopes: string[]`
- `GmailEmailProviderOptionsSchema`
  - `type: "gmail" | "google"`
  - `description: string`
  - `account: string`
- `GoogleCalendarProviderOptionsSchema`
  - `type: "google-calendar" | "gcal"`
  - `description: string`
  - `account: string`
  - `calendarId: string` (default: "primary")
- `GoogleDriveFileSystemProviderOptionsSchema`
  - `type: "google-drive" | "gdrive"`
  - `description: string` (default: "Google Drive filesystem")
  - `account: string`
  - `rootFolderId: string` (default: "root")

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

- Refreshed access tokens are stored in the service instance
- Refresh tokens returned during code exchange are also kept in memory
- Provider-specific state, such as current Gmail message, current Gmail draft, or current calendar event, is stored in provider-local agent state slices
- Token persistence is intentionally left to the integrating application

## Best Practices

- Configure a stable `defaultAccount` when most providers use the same Google identity.
- Persist refreshed credentials outside the service if long-lived operation matters.
- Limit provider scopes to what the application needs when possible.
- Treat Google Drive as an API-backed virtual filesystem, not a drop-in POSIX replacement.
- Be aware that `glob`, `watch`, and `grep` operations are not supported due to Drive API limitations.

## Testing

The package uses vitest for unit testing.

**Run tests:**

```bash
bun test
```

**Run tests in watch mode:**

```bash
bun test:watch
```

**Generate test coverage:**

```bash
bun test:coverage
```

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

MIT License - see LICENSE file for details.
