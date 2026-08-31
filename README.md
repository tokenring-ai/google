# @tokenring-ai/google

Google OAuth account management and concrete Gmail, Calendar, and Drive providers for Token Ring.

## Overview

`@tokenring-ai/google` manages Google OAuth accounts and registers concrete Google-backed providers into the abstract Token Ring services. It handles the complete OAuth 2.0 web flow — authorization URL generation, code exchange, refresh-token storage, automatic access-token refresh, and user profile caching — and exposes authenticated access to the Gmail, Google Calendar, and Google Drive APIs.

The package follows the same extension pattern as other provider packages in the repository: it does not replace the abstract services, it registers concrete providers into them under each configured account name.

Current integrations:

- `GoogleService` for OAuth token handling and authenticated Google API access
- `GmailEmailProvider` for `@tokenring-ai/email`
- `GoogleCalendarProvider` for `@tokenring-ai/calendar`
- `GoogleDriveFileSystemProvider` for `@tokenring-ai/filesystem`
- `GoogleOAuthCallbackResource` for `@tokenring-ai/web-host`

### Key Features

- Centralized Google OAuth account configuration with scopes chosen automatically from enabled integrations
- Authorization URL generation, code exchange, refresh tokens, and automatic access-token refresh
- Token and profile persistence in `VaultService` under the `google` category, keyed by account name
- Authenticated Gmail, Google Calendar, and Google Drive API access through `GoogleService`
- Gmail provider registration for the email package
- Google Calendar provider registration for the calendar package
- Google Drive filesystem provider registration for the filesystem package
- OAuth callback handling at `/oauth/google/callback` via `WebHostService`

The package registers no tools of its own; Gmail, Calendar, and Drive capabilities are exposed through the tools, commands, scripting functions, and RPC endpoints of the abstract packages once the Google providers are configured.

## Installation

```bash
bun add @tokenring-ai/google
```

The plugin default export lives in `plugin.ts` and is imported from the subpath:

```typescript
import GooglePlugin from "@tokenring-ai/google/plugin";
```

## Chat Commands

The plugin registers three slash commands for account management. They are served by `AgentCommandService`:

| Command | Description |
| --- | --- |
| `/google account list` | List available Google accounts |
| `/google account get <name>` | Show a Google account |
| `/google account auth <name>` | Authenticate a Google account |

### `/google account list`

Lists all configured Google accounts with their authentication status, profile, and enabled integrations. When no accounts are configured it returns `No Google accounts are configured.`

**Example:**

```text
/google account list
```

**Output:**

```text
Available Google accounts:
- primary: user@example.com [authenticated, profile (user@example.com), gmail, calendar, drive]
```

### `/google account get <name>`

Displays the account's email, profile email, and authentication state. `name` is a required positional argument.

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

Before the account is authenticated the profile email reads `(available after authentication)`.

### `/google account auth <name>`

Authenticates a Google account through the OAuth web flow. `name` is a required positional argument.

**Example:**

```text
/google account auth primary
```

This command:

1. Builds the callback URL from the local `WebHostService` port and `GOOGLE_OAUTH_CALLBACK_PATH`
2. Generates an OAuth authorization URL and prints it for you to open
3. Waits for the OAuth callback at `/oauth/google/callback`, timing out after five minutes
4. Exchanges the authorization code for access and refresh tokens
5. Stores the tokens in the vault and fetches the user profile

On success it returns `Google account "<name>" authenticated with email <email>.` Token storage is handled by `GoogleService` and persisted to `VaultService`.

## Configuration

The package is configured under the `google` key. The OAuth client credentials are secret references resolved by `@tokenring-ai/secrets`; when omitted they default to the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables.

```yaml
google:
  clientId: { source: env, env: GOOGLE_CLIENT_ID }
  clientSecret: { source: env, env: GOOGLE_CLIENT_SECRET }
  agentDefaults:
    account: primary
  accounts:
    primary:
      email: user@example.com
      gmail:
        description: Primary Gmail inbox
      calendar:
        description: Primary Google Calendar
        calendarId: primary
      drive:
        description: Primary Google Drive
        rootFolderId: root
```

### Configuration Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `clientId` | `string` \| secret ref | No | `{ source: "env", env: "GOOGLE_CLIENT_ID" }` | Google OAuth client ID |
| `clientSecret` | `string` \| secret ref | No | `{ source: "env", env: "GOOGLE_CLIENT_SECRET" }` | Google OAuth client secret |
| `accounts` | `Record<string, GoogleAccount>` | No | `{}` | Connected Google accounts, keyed by name |
| `agentDefaults` | `GoogleAgentOptions` | No | `{}` | Defaults applied to new agents |
| `agentDefaults.account` | `string` | No | — | Google account new agents use by default |

`clientId` and `clientSecret` accept a literal string, an env reference (`{ source: "env", env: "..." }`), or a vault reference (`{ source: "vault", category, key }`). Both default to env references for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The plugin resolves them at configure time, so a misconfigured secret fails immediately rather than on the first OAuth request.

#### GoogleAccount

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `email` | `string` | Yes | — | Google account email address (validated with `z.email()`) |
| `gmail` | `GoogleAccountGmail` | No | — | Gmail integration configuration |
| `calendar` | `GoogleAccountCalendar` | No | — | Calendar integration configuration |
| `drive` | `GoogleAccountDrive` | No | — | Drive integration configuration |

#### GoogleAccountGmail

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `description` | `string` | No | `"Gmail"` | Display name for this account's Gmail integration |

#### GoogleAccountCalendar

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `description` | `string` | No | `"Google Calendar"` | Display name for this account's calendar integration |
| `calendarId` | `string` | No | `"primary"` | Calendar ID to use (`"primary"` for the account's main calendar) |

#### GoogleAccountDrive

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `description` | `string` | No | `"Google Drive filesystem"` | Display name for this account's Drive filesystem |
| `rootFolderId` | `string` | No | `"root"` | Drive folder ID treated as the filesystem root |

### Schema Metadata

The `.meta()` annotations on the config schema drive config UI integration:

| Field | Meta annotations |
| --- | --- |
| `GoogleConfigSchema` | `label: "Google"`, `description: "Google OAuth, Gmail, Calendar, and Drive integration settings"` |
| `clientId` | `description: "Google OAuth client ID"` (sourced value) |
| `clientSecret` | `description: "Google OAuth client secret"` (secret) |
| `accounts` | `label: "Accounts"`, `description: "Connected Google accounts, keyed by name"` |
| `agentDefaults` | `label: "Agent Defaults"` |
| `agentDefaults.account` | `description: "Google account new agents use by default"` |
| `accounts.<name>.email` | `description: "Google account email address"` |
| `accounts.<name>.gmail` | `label: "Gmail"` |
| `accounts.<name>.gmail.description` | `description: "Display name for this account's Gmail integration"` |
| `accounts.<name>.calendar` | `label: "Calendar"` |
| `accounts.<name>.calendar.description` | `description: "Display name for this account's calendar integration"` |
| `accounts.<name>.calendar.calendarId` | `description: "Calendar ID to use ("primary" for the account's main calendar)"` |
| `accounts.<name>.drive` | `label: "Drive"` |
| `accounts.<name>.drive.description` | `description: "Display name for this account's Drive filesystem"` |
| `accounts.<name>.drive.rootFolderId` | `advanced: true`, `description: "Drive folder ID treated as the filesystem root"` |
| `GoogleStoredTokenSchema.refreshToken` | `sensitive: true`, `description: "OAuth refresh token (obtained via login)"` |
| `GoogleStoredTokenSchema.accessToken` | `sensitive: true`, `description: "OAuth access token (obtained via login)"` |

### Schemas

The package exports Zod schemas for configuration validation:

- `GoogleConfigSchema` — `clientId` (sourced value, default `env:GOOGLE_CLIENT_ID`), `clientSecret` (secret, default `env:GOOGLE_CLIENT_SECRET`), `accounts` (record, default `{}`), `agentDefaults` (default `{}`)
- `GoogleAccountSchema` — `email`, optional `gmail`, `calendar`, `drive`
- `GoogleAccountGmailSchema` — `description` (default `"Gmail"`)
- `GoogleAccountCalendarSchema` — `description` (default `"Google Calendar"`), `calendarId` (default `"primary"`)
- `GoogleAccountDriveSchema` — `description` (default `"Google Drive filesystem"`), `rootFolderId` (default `"root"`)
- `GoogleAgentOptionsSchema` — `account` (optional)
- `GoogleStoredTokenSchema` — `refreshToken`, `accessToken`, `expiryDate`, `grantedScopes`, `profile` (all optional)
- `GmailEmailProviderOptionsSchema` — `description`, `account`
- `GoogleCalendarProviderOptionsSchema` — `description`, `account`, `calendarId` (default `"primary"`)
- `GoogleDriveFileSystemProviderOptionsSchema` — `description` (default `"Google Drive filesystem"`), `account`, `rootFolderId` (default `"root"`)
- `GooglePackageConfigSchema` — `google` (the plugin's config schema, `GoogleConfigSchema.prefault({})`)

## Core Components

### `GoogleService`

Main service for Google OAuth and authenticated API requests. It implements `TokenRingService`.

**Service properties:**

```typescript
readonly name = "GoogleService";
description = "Google OAuth account and API access service";
```

**Constructor and configuration:**

```typescript
constructor(app: TokenRingApp);
reconfigure(options: ResolvedGoogleConfig): void;
```

`reconfigure` reconciles the configured accounts against those already registered: it registers or unregisters each account's Gmail, Calendar, and Drive providers, and loads each account's stored tokens from the vault in the background.

**Public properties:**

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Service name: `"GoogleService"` |
| `description` | `string` | Service description |
| `app` | `TokenRingApp` | Reference to the TokenRing app (constructor `readonly`) |

**Methods:**

| Method | Description |
| --- | --- |
| `getAvailableAccounts(): string[]` | Names of all configured accounts |
| `requireAccount(accountName: string): GoogleAccount` | Account configuration; throws if the account is unknown |
| `getAccountStatus(accountName: string)` | Authentication status: `{ isAuthenticated: boolean; profile: UserInfo \| undefined; account: GoogleAccount }`; `isAuthenticated` is `true` when a refresh token is stored |
| `requireAuthorizedAccount(accountName: string)` | Same as `getAccountStatus` but throws `ConfigurationError` when not authenticated |
| `createAuthorizationUrl(accountName: string, redirectUri: string, options?)` | Generate an OAuth authorization URL |
| `beginAuthorization(accountName: string, redirectUri: string)` | Start an OAuth flow: returns `{ authorizationUrl: string; waitForCallback: Promise<string> }` |
| `completePendingAuthorization(callbackUrl: string): void` | Process an OAuth callback URL, validating the `state` parameter and redirect URI |
| `exchangeAuthorizationCode(name: string, code: string, redirectUri: string)` | Exchange the authorization code for tokens, store them, and fetch the profile |
| `withGmail<T>(accountName: string, request, operation)` | Run an authenticated Gmail API operation |
| `withCalendar<T>(accountName: string, request, operation)` | Run an authenticated Calendar API operation |
| `withDrive<T>(accountName: string, request, operation)` | Run an authenticated Drive API operation |

`createAuthorizationUrl` options are `state?: string`, `scopes?: string[]`, `accessType?: "offline" \| "online"` (default `"offline"`), `prompt?: "consent" \| "none" \| "select_account"` (default `"consent"`), and `loginHint?: string` (defaults to the account's email).

The package also exports the callback path constant `GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback"`.

**OAuth flow:**

1. **Authorization URL generation** — `createAuthorizationUrl()` or `beginAuthorization()` builds the URL with scopes derived from the account's enabled integrations.
2. **User authentication** — the user signs in at the generated URL and grants permission.
3. **Callback handling** — `completePendingAuthorization()` processes the callback from `WebHostService`, matching it against the `state` parameter and the pending redirect URI.
4. **Token exchange** — `exchangeAuthorizationCode()` trades the code for access and refresh tokens.
5. **Token storage** — tokens are kept in memory and persisted to `VaultService` under the `google` category.
6. **Automatic refresh** — the OAuth client refreshes expired access tokens and updates stored credentials.

**Scope management:**

Scopes are derived from the account's enabled integrations:

- **User info** — `https://www.googleapis.com/auth/userinfo.email` (always included)
- **Gmail** — `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/gmail.modify`
- **Calendar** — `https://www.googleapis.com/auth/calendar`
- **Drive** — `https://www.googleapis.com/auth/drive`

**Error normalization:** Google API failures are rewritten with the request context and status. A `403` with insufficient permissions or missing granted scopes reports the missing scope URLs and ends with `Re-run /google account auth <name> to grant access.`

### `GmailEmailProvider`

Concrete `EmailProvider` implementation for Gmail. It implements the `EmailProvider` interface from `@tokenring-ai/email`.

**Constructor:**

```typescript
constructor(options: GmailEmailProviderOptions, googleService: GoogleService)
```

**Capabilities:**

- List inbox messages with filtering (box, unread/read, pagination)
- Search messages with a query string and filtering
- Retrieve a specific message by ID
- Create and update drafts
- Send a draft
- Mark messages as read
- List email boxes (Inbox, Sent, Drafts, Spam, Trash)

**Methods:**

| Method | Description |
| --- | --- |
| `listBoxes(): Promise<EmailBox[]>` | List available email boxes (Inbox, Sent, Drafts, Spam, Trash) |
| `getMessages(filter: EmailMessageQueryOptions): Promise<EmailMessagePage>` | List messages in a box with optional unread filter and pagination |
| `searchMessages(filter: EmailSearchOptions): Promise<EmailMessage[]>` | Search messages by query with optional box and unread filters |
| `getMessageById(id: string): Promise<EmailMessage>` | Fetch a full message by ID |
| `createDraft(data: DraftEmailData): Promise<EmailDraft>` | Create a draft with to, cc, bcc, subject, and body |
| `updateDraft(data: EmailDraft): Promise<EmailDraft>` | Update an existing draft |
| `sendDraft(id: string): Promise<void>` | Send a draft by ID |
| `markAsRead(id: string): Promise<void>` | Remove the `UNREAD` label from a message |

Search uses Gmail's search syntax: `box` values map to `in:inbox`, `in:sent`, `in:drafts`, `in:spam`, and `in:trash`; other values become `label:<name>`. Messages and drafts are rebuilt as multipart MIME (`text/plain` and/or `text/html`) before upload.

**Scope requirements:**

- `https://www.googleapis.com/auth/gmail.readonly` — listing, reading, and searching messages
- `https://www.googleapis.com/auth/gmail.compose` — creating and updating drafts
- `https://www.googleapis.com/auth/gmail.send` — sending drafts
- `https://www.googleapis.com/auth/gmail.modify` — marking messages as read

### `GoogleCalendarProvider`

Concrete `CalendarProvider` implementation for Google Calendar. It implements the `CalendarProvider` interface from `@tokenring-ai/calendar`.

**Constructor:**

```typescript
constructor(options: GoogleCalendarProviderOptions, googleService: GoogleService)
```

**Capabilities:**

- List upcoming events with a time range and limit
- Search events by query within a time range
- Retrieve a specific event by ID
- Create events (timed and all-day, with attendees)
- Update events
- Delete events

**Methods:**

| Method | Description |
| --- | --- |
| `getUpcomingEvents(filter: CalendarEventFilterOptions): Promise<ParsedCalendarEvent[]>` | List upcoming events within the time range |
| `searchEvents(filter: CalendarEventSearchOptions): Promise<ParsedCalendarEvent[]>` | Search events by query |
| `createEvent(data: CreateCalendarEventData): Promise<ParsedCalendarEvent>` | Create an event |
| `updateEvent(id: string, data: UpdateCalendarEventData): Promise<ParsedCalendarEvent>` | Update an event by ID |
| `getEventById(id: string): Promise<ParsedCalendarEvent>` | Fetch an event by ID |
| `deleteEvent(id: string): Promise<void>` | Delete an event by ID |

**Scope requirements:**

- `https://www.googleapis.com/auth/calendar` — full access to calendar events

### `GoogleDriveFileSystemProvider`

Concrete `FileSystemProvider` implementation for Google Drive. It implements the `FileSystemProvider` interface from `@tokenring-ai/filesystem`.

**Service properties:**

```typescript
readonly name = "GoogleDriveFileSystemProvider";
```

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

| Method | Description |
| --- | --- |
| `writeFile(filePath: string, content: string \| Buffer): Promise<boolean>` | Create or update a file |
| `appendFile(filePath: string, content: string \| Buffer): Promise<boolean>` | Append content to a file |
| `deleteFile(filePath: string): Promise<boolean>` | Delete a file |
| `readFile(filePath: string): Promise<Buffer \| null>` | Read file content as a buffer |
| `rename(oldPath: string, newPath: string): Promise<boolean>` | Rename or move a file |
| `exists(filePath: string): Promise<boolean>` | Check whether a path exists |
| `stat(filePath: string): Promise<StatLike>` | Return file/directory metadata |
| `createDirectory(dirPath: string, options?: { recursive?: boolean \| undefined }): Promise<boolean>` | Create a directory |
| `copy(source: string, destination: string, options?: { overwrite?: boolean \| undefined }): Promise<boolean>` | Copy a file |
| `getDirectoryTree(path: string, params?: DirectoryTreeOptions): AsyncGenerator<string>` | Generate a directory tree as an async iterator |

**Unsupported filesystem operations:**

- `watch()` and `grep()` throw (`Method watch is not supported by GoogleDriveFileSystemProvider.` and `Method grep is not supported by GoogleDriveFileSystemProvider.`) because the Drive API provides no equivalent to local file watching or content search.
- `glob` is not defined on the provider; `FileSystemService` falls back to a directory-walk glob when a provider has no `glob` method, so globbing still works.

**Path handling:**

- Paths use forward slashes (`/`) as separators
- The root folder is the configured `rootFolderId`; an empty path resolves to it
- Files and folders are cached by ID and path to reduce API calls; the cache is cleared after mutations

**Scope requirements:**

- `https://www.googleapis.com/auth/drive` — full access to Google Drive files

### `GoogleOAuthCallbackResource`

Web resource that handles OAuth callback requests from Google. It implements `WebResource` from `@tokenring-ai/web-host`.

**Constructor:**

```typescript
constructor(googleService: GoogleService)
```

**Registration:** The resource registers a handler for `GOOGLE_OAUTH_CALLBACK_PATH` (`/oauth/google/callback`) with `WebHostService`.

**Behavior:**

- Receives the callback request URL and forwards it to `GoogleService.completePendingAuthorization()`
- Returns a `200` HTML page — `Google account connected` — when the authorization completes
- Returns a `400` HTML page — `Google authentication failed` — with the error message when it does not

## Services

The plugin is service-only: it defines no agent lifecycle hooks. Its plugin-level lifecycle is defined by `install` and `reconfigure`.

### Plugin Lifecycle

| Field | Value |
| --- | --- |
| `name` | `@tokenring-ai/google` |
| `displayName` | Google Services |
| `version` | 0.2.0 |
| `description` | Google OAuth and Gmail integration for Token Ring |
| `configSchema` | `GooglePackageConfigSchema` (`z.object({ google: GoogleConfigSchema.prefault({}) })`) |

| Method | Description |
| --- | --- |
| `install(app)` | Adds `GoogleService` via `app.addService`; waits for `AgentCommandService` and registers the three `/google account ...` commands; waits for `WebHostService` and registers `GoogleOAuthCallbackResource` at `/oauth/google/callback` |
| `reconfigure(app, config)` | Resolves the `clientId`/`clientSecret` secret references with `resolveSecret`, then calls `app.requireService(GoogleService).reconfigure(resolved)` — account reconciliation registers or unregisters the Gmail, Calendar, and Drive providers |

## Integration

The plugin integrates with abstract Token Ring services rather than registering new tools or commands directly. It registers:

- `GoogleService` as a core service
- Gmail providers into `EmailService`, one per account that enables `gmail`
- Google Calendar providers into `CalendarService`, one per account that enables `calendar`
- Google Drive providers into `FileSystemService`, one per account that enables `drive`
- The OAuth callback resource into `WebHostService` at `/oauth/google/callback`
- Tokens and profiles into `VaultService` under the `google` category

Providers are registered under the **account name** — a configured account `primary` registers providers named `primary` in each service. Point the abstract services' `agentDefaults.provider` at the account name to use them:

```yaml
email:
  agentDefaults:
    provider: primary

calendar:
  agentDefaults:
    provider: primary

filesystem:
  agentDefaults:
    provider: primary
```

The package is typically used alongside `@tokenring-ai/email`, `@tokenring-ai/calendar`, `@tokenring-ai/filesystem`, `@tokenring-ai/web-host`, and `@tokenring-ai/vault`. OAuth client credentials are resolved with `@tokenring-ai/secrets` at configure time.

## State Management

`GoogleService` keeps account auth state in memory and persists it to the vault:

- **Token storage** — access and refresh tokens are held per account in memory and written to `VaultService` under the `google` category whenever they change.
- **Profile caching** — the user profile is fetched via the `userinfo.email` scope and cached in memory; it is stored in the vault with the tokens.
- **Token auto-refresh** — the OAuth client refreshes expired access tokens in the background and updates the stored credentials.
- **Session restore** — during `reconfigure`, each account's stored tokens are loaded from the vault so previously authenticated accounts stay authenticated.
- **Provider state** — the Gmail, Calendar, and Drive providers are stateless. Per-agent provider selection, the current message/draft/event, and selected files are owned by the abstract packages' state slices (`EmailState`, `CalendarState`, `FileSystemState`).

## Usage Examples

### Plugin Installation

```typescript
import TokenRingApp from "@tokenring-ai/app";
import PluginManager from "@tokenring-ai/app/PluginManager";
import GooglePlugin from "@tokenring-ai/google/plugin";

const app = new TokenRingApp({
  app: {
    workingDirectory: "./workspace",
    workspaceDirectory: "./workspace",
    configDirectories: ["./config"],
  },
});

const pluginManager = app.addService(new PluginManager(app));
await pluginManager.installPlugins([GooglePlugin]);
```

The `google` configuration (see [Configuration](#configuration)) is supplied through the app's configuration layers.

### Programmatic OAuth Usage

```typescript
import { GoogleService } from "@tokenring-ai/google";

const googleService = app.requireService(GoogleService);

// Begin the OAuth flow
const redirectUri = "http://127.0.0.1:3000/oauth/google/callback";
const { authorizationUrl, waitForCallback } = googleService.beginAuthorization("primary", redirectUri);

// Open authorizationUrl in the browser, then wait for the callback
const callbackUrl = await waitForCallback;

// Exchange the code for tokens
const authStatus = await googleService.exchangeAuthorizationCode("primary", "AUTH_CODE", redirectUri);
```

### Email Integration Example

With a configured `primary` account that enables `gmail`:

```yaml
email:
  agentDefaults:
    provider: primary
```

### Calendar Integration Example

With a configured `primary` account that enables `calendar`:

```yaml
calendar:
  agentDefaults:
    provider: primary
```

### Filesystem Integration Example

With a configured `primary` account that enables `drive`:

```yaml
filesystem:
  agentDefaults:
    provider: primary
```

## Best Practices

- Configure a stable `agentDefaults.account` when most providers use the same Google identity
- Use descriptive account names that reflect the identity or purpose (e.g. "primary", "work", "personal")
- Enable only the integrations (`gmail`, `calendar`, `drive`) you need for each account to keep the requested OAuth scopes minimal
- Set the account `email` to the address you expect to authenticate; it is used as the OAuth `login_hint` and as the draft `From` header
- Treat Google Drive as an API-backed virtual filesystem, not a drop-in POSIX replacement
- Remember that `watch()` and `grep()` are unsupported on the Drive provider; `glob` works through the filesystem service's directory-walk fallback
- Keep `clientId`/`clientSecret` as env or vault secret references rather than literals in the configuration file

## Testing

```bash
bun test            # from plugin/google
bun test:watch
bun test:coverage
bun run build       # typecheck (tsc --noEmit)
```

The suite runs in a Node environment (`bun.config.ts`). `test/GoogleService.test.ts` covers authorization URL scope selection per enabled integration and an end-to-end OAuth flow through the web-host callback with vault token storage. `test/GmailEmailProvider.test.ts` covers label-derived box listing, paginated message retrieval with header/body parsing, and `markAsRead`.

## Dependencies

| Package | Purpose |
| --- | --- |
| `@tokenring-ai/agent` | `AgentCommandService` and agent command types |
| `@tokenring-ai/app` | `TokenRingPlugin`, service registry, `ConfigurationError` |
| `@tokenring-ai/calendar` | `CalendarService` provider registration |
| `@tokenring-ai/email` | `EmailService` provider registration |
| `@tokenring-ai/filesystem` | `FileSystemService` provider registration |
| `@tokenring-ai/secrets` | Secret references and `resolveSecret` for OAuth client credentials |
| `@tokenring-ai/utility` | `KeyedRegistry`, `stripUndefinedKeys`, `deepEquals` |
| `@tokenring-ai/vault` | Encrypted storage for OAuth tokens |
| `@tokenring-ai/web-host` | `WebHostService` and `WebResource` for the OAuth callback |
| `googleapis` | Google API client libraries (OAuth2, Gmail, Calendar, Drive, userinfo) |
| `zod` | Schema validation |

## Exports

The package root (`@tokenring-ai/google`) exports from `index.ts`:

| Export | Kind | Description |
| --- | --- | --- |
| `GoogleService` | class (default) | OAuth and Google API access service |
| `GmailEmailProvider` | class (default) | Gmail `EmailProvider` implementation |
| `GoogleCalendarProvider` | class (default) | Google Calendar `CalendarProvider` implementation |
| `GoogleDriveFileSystemProvider` | class (default) | Google Drive `FileSystemProvider` implementation |
| `GoogleConfigSchema` | schema | Plugin config schema |
| `GoogleAccountSchema` | schema | Account config schema |
| `GoogleStoredTokenSchema` | schema | Vault token schema |
| `GmailEmailProviderOptionsSchema` | schema | Gmail provider options schema |
| `GoogleCalendarProviderOptionsSchema` | schema | Calendar provider options schema |
| `GoogleDriveFileSystemProviderOptionsSchema` | schema | Drive provider options schema |
| `ParsedGoogleConfig` | type | Parsed config shape (`z.output<typeof GoogleConfigSchema>`) |
| `ResolvedGoogleConfig` | type | Config with OAuth client secrets resolved |

The plugin default export is not re-exported from `index.ts`; import it from the subpath `@tokenring-ai/google/plugin`.

## License

MIT License — see LICENSE file for details.
