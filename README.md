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

```typescript
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
- OAuth callback handling via `WebHostService`

## Chat Commands

| Command                       | Description                                |
|-------------------------------|--------------------------------------------|
| `/google account list`        | List all available Google accounts         |
| `/google account get <name>`  | Show details for a specific Google account |
| `/google account auth <name>` | Authenticate a Google account via OAuth    |

### Command Details

#### `/google account list`

Lists all configured Google accounts with their authentication status and enabled integrations.

**Example:**

```text
/google account list
```

**Output:**

```text
Available Google accounts:
- primary: user@example.com [authenticated, profile (user@example.com), gmail, calendar, drive]
```

#### `/google account get <name>`

Displays detailed information about a specific Google account.

**Example:**

```text
/google account get primary
```

**Output:**

```text
Account: primary (user@example.com)
User Profile Email: user@example.com
Authenticated: yes
```

#### `/google account auth <name>`

Authenticates a Google account using OAuth flow. Opens a URL for sign-in and waits for the callback.

**Example:**

```text
/google account auth primary
```

This command:

1. Generates an OAuth authorization URL
2. Displays the URL for you to open in your browser
3. Listens for the OAuth callback via `WebHostService`
4. Exchanges the authorization code for tokens
5. Stores the tokens in the vault
6. Fetches and stores the user profile

## Core Components

### `GoogleService`

Main service for Google OAuth and authenticated HTTP requests.

**Implements:** `TokenRingService`

**Constructor:**

```typescript
constructor(app: TokenRingApp, options: GoogleConfig)
```

**Properties:**

| Property      | Type             | Description                          |
|---------------|------------------|--------------------------------------|
| `name`        | `string`         | Service name: "GoogleService"        |
| `description` | `string`         | Service description                  |
| `app`         | `TokenRingApp`   | Reference to the TokenRing app       |
| `options`     | `GoogleConfig`   | Configured Google options            |

**Methods:**

- `getAvailableAccounts(): string[]` - Returns list of configured account names
- `getAccountStatus(accountName: string): { isAuthenticated: boolean; profile: UserInfo | undefined; account: GoogleAccount }` - Returns authentication status, profile, and account configuration
- `requireAccount(accountName: string): GoogleAccount` - Returns the account configuration, throws if not found
- `requireAuthorizedAccount(accountName: string): { isAuthenticated: boolean; profile: UserInfo | undefined; account: GoogleAccount }` - Returns account status, throws if not authenticated
- `createAuthorizationUrl(accountName: string, redirectUri: string, options?: { state?: string; scopes?: string[]; accessType?: "offline" | "online"; prompt?: "consent" | "none" | "select_account"; loginHint?: string }): string` - Generates OAuth authorization URL
- `beginAuthorization(accountName: string, redirectUri: string): { authorizationUrl: string; waitForCallback: Promise<string> }` - Begins OAuth flow, returns URL and promise for callback
- `completePendingAuthorization(callbackUrl: string): void` - Processes the OAuth callback URL
- `exchangeAuthorizationCode(name: string, code: string, redirectUri: string): Promise<{ isAuthenticated: boolean; profile: UserInfo | undefined; account: GoogleAccount }>` - Exchanges OAuth code for tokens
- `withGmail<T>(accountName: string, request: GoogleRequestOptions, operation: (gmail: gmail_v1.Gmail) => Promise<T>): Promise<T>` - Makes authenticated Gmail API requests
- `withCalendar<T>(accountName: string, request: GoogleRequestOptions, operation: (calendar: calendar_v3.Calendar) => Promise<T>): Promise<T>` - Makes authenticated Calendar API requests
- `withDrive<T>(accountName: string, request: GoogleRequestOptions, operation: (drive: drive_v3.Drive) => Promise<T>): Promise<T>` - Makes authenticated Drive API requests

**OAuth Flow:**

The `GoogleService` manages the complete OAuth 2.0 flow:

1. **Authorization URL Generation**: `createAuthorizationUrl()` or `beginAuthorization()` generates the URL with appropriate scopes based on the account's enabled integrations
2. **User Authentication**: User signs in via the generated URL and grants permissions
3. **Callback Handling**: `completePendingAuthorization()` processes the callback URL from `WebHostService`
4. **Token Exchange**: `exchangeAuthorizationCode()` exchanges the authorization code for access and refresh tokens
5. **Token Storage**: Tokens are stored in memory and persisted to `VaultService`
6. **Automatic Refresh**: The OAuth client automatically refreshes expired access tokens

**Scope Management:**

Scopes are automatically determined based on enabled integrations:

- **User Info**: `https://www.googleapis.com/auth/userinfo.email` (always included)
- **Gmail**: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.send`
- **Calendar**: `https://www.googleapis.com/auth/calendar`
- **Drive**: `https://www.googleapis.com/auth/drive`

### `GmailEmailProvider`

Concrete `EmailProvider` implementation for Gmail.

**Implements:** `EmailProvider`

**Constructor:**

```typescript
constructor(options: GmailEmailProviderOptions, googleService: GoogleService)
```

**Capabilities:**

- List inbox messages with filtering (unread/read)
- Search messages with query and filtering
- Retrieve specific message by ID
- Create and update drafts
- Send the current draft
- List email boxes (Inbox, Sent, Drafts, Spam, Trash)

**Methods:**

- `listBoxes(): Promise<EmailBox[]>` - Lists available email boxes (Inbox, Sent, Drafts, Spam, Trash)
- `getMessages(filter: EmailMessageQueryOptions): Promise<EmailMessagePage>` - Lists messages from inbox with optional unread filter
- `searchMessages(filter: EmailSearchOptions): Promise<EmailMessage[]>` - Searches messages with query string and optional unread filter
- `getMessageById(id: string): Promise<EmailMessage>` - Fetches full message content by ID
- `createDraft(data: DraftEmailData): Promise<EmailDraft>` - Creates a new draft with to, cc, bcc, subject, and body
- `updateDraft(data: EmailDraft): Promise<EmailDraft>` - Updates an existing draft
- `sendDraft(id: string): Promise<void>` - Sends the draft by ID

**Supported Operations:**

The provider supports all standard email operations through the Gmail API:

- **Reading**: Lists and retrieves messages with full headers and body content
- **Searching**: Uses Gmail's search syntax for flexible message filtering
- **Drafts**: Creates, updates, and sends drafts with multipart MIME support
- **Labels**: Returns Gmail label IDs along with messages

**Scope Requirements:**

- `https://www.googleapis.com/auth/gmail.readonly` - For listing and reading messages
- `https://www.googleapis.com/auth/gmail.compose` - For creating and updating drafts
- `https://www.googleapis.com/auth/gmail.send` - For sending drafts

### `GoogleCalendarProvider`

Concrete `CalendarProvider` implementation for Google Calendar.

**Implements:** `CalendarProvider`

**Constructor:**

```typescript
constructor(options: GoogleCalendarProviderOptions, googleService: GoogleService)
```

**Capabilities:**

- List upcoming events with time range filtering
- Search events with query and time range
- Retrieve specific event by ID
- Create events
- Update events
- Delete events

**Methods:**

- `getUpcomingEvents(filter: CalendarEventFilterOptions): Promise<CalendarEvent[]>` - Lists upcoming events from the calendar with time range and limit
- `searchEvents(filter: CalendarEventSearchOptions): Promise<CalendarEvent[]>` - Searches events by query string within time range
- `createEvent(data: CreateCalendarEventData): Promise<CalendarEvent>` - Creates a new event with title, description, location, attendees, and timing
- `updateEvent(id: string, data: UpdateCalendarEventData): Promise<CalendarEvent>` - Updates an existing event by ID
- `getEventById(id: string): Promise<CalendarEvent>` - Fetches a specific event by ID
- `deleteEvent(id: string): Promise<void>` - Deletes an event by ID

**Supported Operations:**

The provider supports all standard calendar operations through the Google Calendar API:

- **Listing**: Retrieves events within specified time ranges with customizable limits
- **Searching**: Uses Google Calendar's search functionality for event queries
- **Event Creation**: Supports all-day and timed events with attendees
- **Event Updates**: Modifies existing events while preserving event ID
- **Event Deletion**: Removes events from the calendar

**Scope Requirements:**

- `https://www.googleapis.com/auth/calendar` - Full access to calendar events

### `GoogleDriveFileSystemProvider`

Concrete `FileSystemProvider` implementation for Google Drive.

**Implements:** `FileSystemProvider`

**Constructor:**

```typescript
constructor(options: GoogleDriveFileSystemProviderOptions, googleService: GoogleService)
```

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

- `writeFile(filePath: string, content: string | Buffer): Promise<boolean>` - Creates or updates a file
- `appendFile(filePath: string, content: string | Buffer): Promise<boolean>` - Appends content to a file
- `deleteFile(filePath: string): Promise<boolean>` - Deletes a file
- `readFile(filePath: string): Promise<Buffer | null>` - Reads file content as a buffer
- `rename(oldPath: string, newPath: string): Promise<boolean>` - Renames or moves a file
- `exists(filePath: string): Promise<boolean>` - Checks if a path exists
- `stat(filePath: string): Promise<StatLike>` - Returns file/directory metadata
- `createDirectory(dirPath: string, options?: { recursive?: boolean }): Promise<boolean>` - Creates a directory
- `copy(source: string, destination: string, options?: { overwrite?: boolean }): Promise<boolean>` - Copies a file
- `getDirectoryTree(path: string, params?: DirectoryTreeOptions): AsyncGenerator<string>` - Generates directory tree as async iterator

**Unsupported filesystem operations:**

The following methods throw errors because the Drive API does not provide equivalent behavior to local filesystem providers:

- `glob()` - Pattern-based file matching not supported
- `watch()` - File system watching not supported
- `grep()` - Content search across files not supported

**Path Handling:**

- Paths use forward slashes (`/`) as separators
- The root folder is represented as an empty string or the configured `rootFolderId`
- Files and folders are cached by ID for performance

**Scope Requirements:**

- `https://www.googleapis.com/auth/drive` - Full access to Google Drive files

### `GoogleOAuthCallbackResource`

Web resource that handles OAuth callback requests from Google.

**Implements:** `WebResource`

**Constructor:**

```typescript
constructor(googleService: GoogleService)
```

**Registration:**

The resource is automatically registered with `WebHostService` at the path `/oauth/google/callback`.

**Behavior:**

- Handles GET requests to the callback URL
- Extracts the authorization code and state from query parameters
- Calls `GoogleService.completePendingAuthorization()` to process the callback
- Returns an HTML page indicating success or failure
- Resolves the pending authorization promise in `GoogleService`

**HTML Response:**

- **Success**: Displays "Google account connected" with instructions to close the tab
- **Failure**: Displays the error message and returns HTTP 400

## Usage Examples

### Plugin Installation

```typescript
import TokenRingApp from "@tokenring-ai/app";
import GooglePlugin from "@tokenring-ai/google/plugin";

const app = new TokenRingApp();
app.usePlugin(GooglePlugin, {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    agentDefaults: {
      account: "primary"
    },
    accounts: {
      primary: {
        email: "user@example.com",
        gmail: {
          description: "Primary Gmail inbox"
        },
        calendar: {
          description: "Primary Google Calendar",
          calendarId: "primary"
        },
        drive: {
          description: "Primary Google Drive",
          rootFolderId: "root"
        }
      }
    }
  }
});
```

### Programmatic OAuth Usage

```typescript
import { GoogleService } from "@tokenring-ai/google";

const googleService = app.requireService(GoogleService);

// Begin OAuth flow
const redirectUri = "http://localhost:3000/oauth/google/callback";
const { authorizationUrl, waitForCallback } = googleService.beginAuthorization("primary", redirectUri);

// Open authorizationUrl in browser, then wait for callback
const callbackUrl = await waitForCallback;

// Exchange code for tokens
const authStatus = await googleService.exchangeAuthorizationCode("primary", "AUTH_CODE", redirectUri);
```

### Email Integration Example

```yaml
email:
  agentDefaults:
    provider: "gmail"
  providers:
    gmail:
      type: "gmail"
      description: "Primary Gmail inbox"
      account: "primary"
```

### Calendar Integration Example

```yaml
calendar:
  agentDefaults:
    provider: "google-calendar"
  providers:
    "google-calendar":
      type: "google-calendar"
      description: "Primary Google Calendar"
      account: "primary"
      calendarId: "primary"
```

### Filesystem Integration Example

```yaml
filesystem:
  agentDefaults:
    provider: "gdrive"
    selectedFiles: []
  providers:
    gdrive:
      type: "google-drive"
      description: "Primary Google Drive root"
      account: "primary"
      rootFolderId: "root"
```

## Configuration

The package is configured under the `google` key, and optionally under the abstract package keys it extends.

### Google Configuration Schema

```yaml
google:
  clientId: "your-client-id.apps.googleusercontent.com"
  clientSecret: "your-client-secret"
  agentDefaults:
    account: "primary"
  accounts:
    primary:
      email: "user@example.com"
      gmail:
        description: "Gmail"
      calendar:
        description: "Google Calendar"
        calendarId: "primary"
      drive:
        description: "Google Drive filesystem"
        rootFolderId: "root"
```

### Environment Variables

| Variable               | Description                | Required |
|------------------------|----------------------------|----------|
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID     | Yes*     |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes*     |

\* Can also be provided in configuration

### Configuration Options

#### GoogleConfig

| Field           | Type                            | Description                          |
|-----------------|---------------------------------|--------------------------------------|
| `clientId`      | `string`                        | Google OAuth client ID               |
| `clientSecret`  | `string`                        | Google OAuth client secret           |
| `accounts`      | `Record<string, GoogleAccount>` | Configured Google accounts           |
| `agentDefaults` | `GoogleAgentOptions`            | Default options for agents           |

#### GoogleAccount

| Field      | Type                    | Description            |
|------------|-------------------------|------------------------|
| `email`    | `string`                | User email address     |
| `gmail`    | `GoogleAccountGmail`    | Gmail configuration    |
| `calendar` | `GoogleAccountCalendar` | Calendar configuration |
| `drive`    | `GoogleAccountDrive`    | Drive configuration    |

#### GoogleAccountGmail

| Field         | Type     | Description                       | Default |
|---------------|----------|-----------------------------------|---------|
| `description` | `string` | Description of this Gmail account | "Gmail" |

#### GoogleAccountCalendar

| Field         | Type     | Description                  | Default           |
|---------------|----------|------------------------------|-------------------|
| `description` | `string` | Description of this calendar | "Google Calendar" |
| `calendarId`  | `string` | Calendar ID to use           | "primary"         |

#### GoogleAccountDrive

| Field          | Type     | Description               | Default                   |
|----------------|----------|---------------------------|---------------------------|
| `description`  | `string` | Description of this Drive | "Google Drive filesystem" |
| `rootFolderId` | `string` | Root folder ID            | "root"                    |

### Schemas

The following Zod schemas are exported for configuration validation:

- `GoogleConfigSchema`
  - `clientId?: string`
  - `clientSecret?: string`
  - `accounts: Record<string, GoogleAccount>`
  - `agentDefaults?: GoogleAgentOptions`

- `GoogleAccountSchema`
  - `email: string`
  - `gmail: GoogleAccountGmail`
  - `calendar: GoogleAccountCalendar`
  - `drive: GoogleAccountDrive`

- `GoogleAccountGmailSchema`
  - `description: string` (default: "Gmail")

- `GoogleAccountCalendarSchema`
  - `description: string` (default: "Google Calendar")
  - `calendarId: string` (default: "primary")

- `GoogleAccountDriveSchema`
  - `description: string` (default: "Google Drive filesystem")
  - `rootFolderId: string` (default: "root")

- `GoogleStoredTokenSchema`
  - `refreshToken?: string`
  - `accessToken?: string`
  - `expiryDate?: number`
  - `grantedScopes?: string[]`
  - `profile?: UserInfo`

- `GmailEmailProviderOptionsSchema`
  - `description: string`
  - `account: string`

- `GoogleCalendarProviderOptionsSchema`
  - `description: string`
  - `account: string`
  - `calendarId: string` (default: "primary")

- `GoogleDriveFileSystemProviderOptionsSchema`
  - `description: string` (default: "Google Drive filesystem")
  - `account: string`
  - `rootFolderId: string` (default: "root")

## Integration

The plugin integrates with abstract Token Ring services rather than registering new tools or commands directly.

It registers:

- `GoogleService` as a core service
- Gmail providers into `EmailService`
- Google Calendar providers into `CalendarService`
- Google Drive providers into `FileSystemService`
- OAuth callback resource into `WebHostService`

This means `@tokenring-ai/google` is typically used alongside:

- `@tokenring-ai/email`
- `@tokenring-ai/calendar`
- `@tokenring-ai/filesystem`
- `@tokenring-ai/web-host`

## State Management

`GoogleService` keeps account token updates in memory at runtime.

Important behavior:

- **Token Storage**: Refreshed access tokens and refresh tokens are stored in the service instance and automatically persisted to `VaultService`
- **Profile Caching**: User profile information (email, name, etc.) is fetched once and cached in memory
- **Token Auto-Refresh**: The OAuth client automatically refreshes expired access tokens and updates stored credentials
- **Provider State**: Provider-specific state, such as current Gmail message, current Gmail draft, or current calendar event, is stored in provider-local agent state slices
- **Vault Persistence**: All tokens are persisted to `VaultService` under the "google" category, keyed by account name

## Best Practices

- Configure a stable `agentDefaults.account` when most providers use the same Google identity
- Persist refreshed credentials outside the service if long-lived operation matters (though vault persistence handles this automatically)
- Limit provider scopes to what the application needs when possible (scopes are automatically determined by enabled integrations)
- Treat Google Drive as an API-backed virtual filesystem, not a drop-in POSIX replacement
- Be aware that `glob`, `watch`, and `grep` operations are not supported due to Drive API limitations
- Enable only the integrations (gmail, calendar, drive) that you need for each account to minimize required scopes
- Use descriptive account names that reflect the identity or purpose (e.g., "primary", "work", "personal")
- Configure the `email` field in account configuration to match the user's expected email address

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

- `@tokenring-ai/agent` - Agent orchestration and command handling
- `@tokenring-ai/app` - Base application and service registry
- `@tokenring-ai/calendar` - Calendar service for provider registration
- `@tokenring-ai/email` - Email service for provider registration
- `@tokenring-ai/filesystem` - Filesystem service for provider registration
- `@tokenring-ai/utility` - Utility functions and registries
- `@tokenring-ai/vault` - Secure token storage
- `@tokenring-ai/web-host` - OAuth callback handling
- `googleapis` - Google API client libraries
- `zod` - Schema validation

## Exports

The package exports the following:

```typescript
// Main classes
export { default as GmailEmailProvider }
export { default as GoogleCalendarProvider }
export { default as GoogleDriveFileSystemProvider }
export { default as GoogleService }

// Schemas
export {
  GmailEmailProviderOptionsSchema,
  GoogleAccountSchema,
  GoogleCalendarProviderOptionsSchema,
  GoogleConfigSchema,
  GoogleDriveFileSystemProviderOptionsSchema,
  GoogleStoredTokenSchema,
}
```

## License

MIT License - see LICENSE file for details.
