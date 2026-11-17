# @tokenring-ai/google

Google OAuth account management and concrete Gmail, Calendar and Google Drive integrations for Token Ring.

## Overview

`@tokenring-ai/google` manages Google OAuth accounts and registers concrete Google-backed providers into the abstract Token Ring services. It handles the complete OAuth 2.0 web flow — authorization URL generation, code exchange, refresh-token storage, automatic access-token refresh, and user profile caching — and exposes authenticated access to the Gmail, Google Calendar, and Google Drive APIs.

The package follows the same extension pattern as other provider packages in the repository: it does not replace the abstract services, it registers concrete providers into them under each configured account name.

Current integrations:

- `GoogleService` for OAuth token handling and authenticated Google API access
- `GmailEmailProvider` for `@tokenring-ai/email`
- `GoogleCalendarProvider` for `@tokenring-ai/calendar`
- `GoogleDriveStore`, a `googledrive://` remote store registered with `RemoteStoreService` from `@tokenring-ai/filesystem`
- `GoogleOAuthCallbackResource` for `@tokenring-ai/web-host`

### Key Features

- Centralized Google OAuth account configuration with scopes chosen automatically from enabled integrations
- Authorization URL generation, code exchange, refresh tokens, and automatic access-token refresh
- Token and profile persistence in `VaultService` under the `google` category, keyed by account name
- Authenticated Gmail, Google Calendar, and Google Drive API access through `GoogleService`
- Gmail provider registration for the email package
- Google Calendar provider registration for the calendar package
- Google Drive as a URL-addressed remote store (`googledrive://<account>/<fileId>`), one mount per account with `drive` configured; read-only unless `writable: true`, and in `@` search only with `contextualSearch: true`
- OAuth callback handling at `/oauth/google/callback` via `WebHostService`

The package registers no tools of its own; Gmail and Calendar capabilities are exposed through the tools, commands, scripting functions, and RPC endpoints of the abstract packages once the Google providers are configured, and Drive through the `remote_*` tools, `/rpc/remote` endpoint and Remote files app of `@tokenring-ai/filesystem`.

## Installation

```bash
bun add @tokenring-ai/google
```

The plugin default export lives in `plugin.ts` and is imported from the subpath:

```typescript
import GooglePlugin from "@tokenring-ai/google/plugin";
```

## Setup: the Connect Google wizard

The easiest way to connect Google needs no terminal and no environment variables. In the web app open **Email** or **Calendar** and click **Connect Google** (or open **Configuration**, then the Google plugin). The wizard, at `/configuration/connect-google`, walks through:

1. What you will do and why.
2. Creating your Google access, in plain steps: a Google Cloud project, the Gmail and Google Calendar APIs, the OAuth consent screen (user type External, yourself added as a test user), and an OAuth client ID of type **Web application**, with the exact redirect URI (`http://127.0.0.1:<port>/oauth/google/callback`, computed from the running server) ready to copy.
3. Pasting the Client ID and Client secret. Both are saved to the vault (category `google`, keys `oauth-client.id` and `oauth-client.secret`) and only `{ source: vault }` references are written to the user's settings. The secret is never returned by the server, rendered, or logged.
4. **What should TokenRing use?** Checkboxes for Email (Gmail), Calendar and Files (Google Drive), at least one required, each with a plain one-liner and what Google is asked to allow (Drive: read and change **all** files in the Drive). Email and Calendar are ticked at first and Drive is not. Nothing is linked unless the user chooses it.
5. **Connect**, which starts the same sign-in as `/connect google` (Google's consent opens in a new tab) for exactly the chosen services, and shows progress, the connected account, or a plain-language explanation of what went wrong.
6. Links into Email and Calendar (only for the services that were linked).

Above the steps, **Connected accounts** lists every account with its email, a chip per linked service and its status (`Connected`, or `Needs sign-in` when no refresh token is stored), with **Change services** and **Disconnect** per account (see below).

There is a matching [step-by-step guide](../../docs/docs/guides/connect-google.md). The Gmail, Calendar and Drive APIs each need enabling in the Google project, but only for the services the user will link. It uses the existing `GoogleService` for the authorization URL, callback and token exchange; `GoogleConnectService` only drives it from a web session.

### Wizard RPC (`/rpc/google`)

Served on the normal authenticated RPC socket like every other endpoint. No result contains the client secret or a token.

| Method | Type | Description |
| --- | --- | --- |
| `getSetup` | query | Redirect URIs, whether credentials can be saved (vault unlocked), where the client ID and secret come from (`vault`, `environment`, `settings`, `none`), the client ID, and the accounts |
| `saveCredentials` | mutation | Saves the client ID and secret to the vault and a reference to each into the global settings. Results: `success`, `vaultLocked`, `invalid` |
| `startConnect` | mutation | Input `{ email, services }`, `services` being a non-empty list of `gmail`, `calendar`, `drive`. Adds the account with exactly those services if it is new, and starts the sign-in asking Google for only their scopes. Results: `started` (with the Google sign-in URL), `needsCredentials`, `vaultLocked`, `invalid` |
| `getConnectStatus` | query | The current attempt: `waiting`, `finishing`, `connected`, `failed` (with a mapped `error`), or `cancelled`. Carries the `services` it links |
| `cancelConnect` | mutation | Stops waiting for Google |
| `listAccounts` | query | `{ accounts: [{ name, email, gmail, calendar, drive, connected }] }`. No tokens |
| `updateAccountServices` | mutation | Input `{ name, services }`. Only removing services: updates the settings (providers follow) and answers `saved`. Adding a service needs new scopes, so it starts the re-authorization for that account and answers `needsConsent` with an attempt, followed with `getConnectStatus` like a sign-in; the new services are written to the settings only once Google agrees, so a failed or cancelled consent changes nothing. Other results: `needsCredentials`, `vaultLocked`, `invalid` |
| `disconnectAccount` | mutation | Input `{ name }`. Answers `disconnected` with `revoke` (`confirmed`, `notConfirmed`, `nothingToRevoke`), a `message` that says honestly whether Google confirmed, and the remaining accounts; or `vaultLocked` (nothing is touched) or `invalid` |

Failures are mapped from what the plugin throws (see `connectErrors.ts`): `accessDenied`, `redirectUriMismatch`, `wrongClient`, `invalidGrant`, `noRefreshToken`, `vaultLocked`, `timedOut`, `exchangeFailed`; anything else is `unknown` and shown verbatim.

### Scopes per service

The account's linked services decide what Google is asked for; Drive is requested only when it was chosen. The identity scope is always added so TokenRing can read which email signed in. The table lives in `scopes.ts` (`scopesForServices`).

| Service | Scopes requested | In plain words |
| --- | --- | --- |
| identity (always) | `userinfo.email` | Which address signed in |
| `gmail` | `gmail.readonly`, `gmail.compose`, `gmail.send`, `gmail.modify` | Read, write drafts, send and organise mail |
| `calendar` | `calendar` | Read and change events |
| `drive` | `drive` | Read and change **all** files in the Drive |

`GoogleService.beginAuthorization(name, redirectUri, { services? })` asks for the given services' scopes, or, without `services` (as in `/google account auth <name>`), for exactly the services the account is configured with.

### Changing services and disconnecting

**Change services** (`updateAccountServices`): taking a service away updates the account in the settings (every settings layer that defines it) and `GoogleService` unregisters that provider. Google keeps listing the old permission until the account is disconnected or removed at `myaccount.google.com/permissions`, and the result says so. Adding a service re-runs consent for the account with the full new set of scopes.

**Disconnect** (`disconnectAccount`, `/google account remove <name>`) does, in this order: cancel a sign-in waiting for the account; ask Google to revoke the refresh token (`POST https://oauth2.googleapis.com/revoke`, best effort, 10 second limit); unregister the account's Email, Calendar and Drive providers and forget its tokens in memory; delete the vault entry (category `google`, key = the account name); remove the account from the settings. The OAuth client ID and secret are shared by every account and stay. The vault must be unlocked, otherwise nothing is done and `vaultLocked` is returned.

What revoke does and does not guarantee: Google answering `200` is reported as `confirmed`, and then the token is dead at Google, including any copy. A network failure, a timeout or an error status is reported as `notConfirmed` with a message pointing at `myaccount.google.com/permissions`; the account is removed from TokenRing anyway, but Google may still list the grant. With no stored token the result is `nothingToRevoke`. Agents whose selected Email or Calendar provider was that account get a clear error ("no longer available ... Select another one") instead of a crash.

There is deliberately no agent tool that connects, changes or disconnects accounts: it is the person's decision, through the wizard or the slash commands.

### Advanced: environment variables and chat commands

If you prefer, supply the OAuth client yourself (see Configuration below): set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or point `clientId` and `clientSecret` at vault entries, then sign in with `/connect google <email>` or `/google account auth <name>`.

`/connect google <email> [--name=<name>] [--save=global|workspace] [--gmail] [--calendar] [--drive]` links only the services the user chooses. Without service flags it asks a multi-select question (Email and Calendar pre-ticked, Drive not, at least one required). The question is posted with `whenUnanswered: null`, so when nobody can answer (an unattended caller, or the deadline passes) it is never answered with the pre-ticked boxes: the command fails with `Usage: /connect google <email> [--gmail] [--calendar] [--drive]. Choose at least one service to link; nothing is linked by default.` and saves nothing. Passing any of `--gmail`, `--calendar`, `--drive` skips the question and links exactly the flagged services. The account is saved with exactly those services (taking away any it had in that settings layer) and only their scopes are requested. Create the client as a **Web application** and add `http://127.0.0.1:<port>/oauth/google/callback` as an authorized redirect URI.

## Chat Commands

The plugin registers four slash commands for account management. They are served by `AgentCommandService`:

| Command | Description |
| --- | --- |
| `/google account list` | List available Google accounts |
| `/google account get <name>` | Show a Google account |
| `/google account auth <name>` | Authenticate a Google account (asks for exactly the services it is configured with) |
| `/google account remove <name>` (alias `/google account disconnect`) | Disconnect a Google account: revoke at Google (best effort), delete its vault entry, remove it from the settings, unregister its providers. Asks for confirmation unless `--yes` |

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
        writable: false          # default; true lets agents and the UI create/replace files
        contextualSearch: false  # default; true adds this Drive to chat @ search
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
| `drive` | `GoogleAccountDrive` | No | — | Drive integration configuration. Makes the account a `googledrive://<account>/` remote-store mount |

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
| `description` | `string` | No | `"Google Drive"` | Display name for this account's Drive (the mount label is `<description> · <account>`) |
| `rootFolderId` | `string` | No | `"root"` | Drive folder ID that `googledrive://<account>/` opens |
| `writable` | `boolean` | No | `false` | Let agents and the UI create and replace files in this Drive |
| `contextualSearch` | `boolean` | No | `false` | Include this Drive in chat `@` mention search, as its own category |

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
| `accounts.<name>.drive.description` | `description: "Display name for this account's Drive"` |
| `accounts.<name>.drive.rootFolderId` | `advanced: true`, `description: "Drive folder ID that googledrive://<account>/ opens"` |
| `accounts.<name>.drive.writable` | `description: "Let agents and the UI create and replace files in this Drive"` |
| `accounts.<name>.drive.contextualSearch` | `description: "Include this Drive in chat @ mention search, as its own category"` |
| `GoogleStoredTokenSchema.refreshToken` | `sensitive: true`, `description: "OAuth refresh token (obtained via login)"` |
| `GoogleStoredTokenSchema.accessToken` | `sensitive: true`, `description: "OAuth access token (obtained via login)"` |

### Schemas

The package exports Zod schemas for configuration validation:

- `GoogleConfigSchema` — `clientId` (sourced value, default `env:GOOGLE_CLIENT_ID`), `clientSecret` (secret, default `env:GOOGLE_CLIENT_SECRET`), `accounts` (record, default `{}`), `agentDefaults` (default `{}`)
- `GoogleAccountSchema` — `email`, optional `gmail`, `calendar`, `drive`
- `GoogleAccountGmailSchema` — `description` (default `"Gmail"`)
- `GoogleAccountCalendarSchema` — `description` (default `"Google Calendar"`), `calendarId` (default `"primary"`)
- `GoogleAccountDriveSchema` — `description` (default `"Google Drive"`), `rootFolderId` (default `"root"`), `writable` (default `false`), `contextualSearch` (default `false`)
- `GoogleAgentOptionsSchema` — `account` (optional)
- `GoogleStoredTokenSchema` — `refreshToken`, `accessToken`, `expiryDate`, `grantedScopes`, `profile` (all optional)
- `GmailEmailProviderOptionsSchema` — `description`, `account`
- `GoogleCalendarProviderOptionsSchema` — `description`, `account`, `calendarId` (default `"primary"`)
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

`reconfigure` reconciles the configured accounts against those already registered: it registers or unregisters each account's Gmail and Calendar providers, calls `RemoteStoreService.mountsChanged()` (when that service exists) so Drive mounts and their `@` search providers follow the new config, and loads each account's stored tokens from the vault in the background.

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
| `getDriveAccounts(): { name: string; drive }[]` | Accounts that configure `drive`, with their parsed Drive settings; these are the mounts of the `googledrive://` store |
| `requireAccount(accountName: string): GoogleAccount` | Account configuration; throws if the account is unknown |
| `getAccountStatus(accountName: string)` | Authentication status: `{ isAuthenticated: boolean; profile: UserInfo \| undefined; account: GoogleAccount }`; `isAuthenticated` is `true` when a refresh token is stored |
| `requireAuthorizedAccount(accountName: string)` | Same as `getAccountStatus` but throws `ConfigurationError` when not authenticated |
| `createAuthorizationUrl(accountName: string, redirectUri: string, options?)` | Generate an OAuth authorization URL |
| `beginAuthorization(accountName: string, redirectUri: string, options?: { services? })` | Start an OAuth flow: returns `{ authorizationUrl: string; waitForCallback: Promise<string> }`. Asks for the scopes of `options.services`, or of the account's configured services |
| `getAccountServices(accountName: string)` | The services (`gmail`, `calendar`, `drive`) the account is configured with |
| `disconnectAccount(accountName: string)` | Cancel a pending sign-in, revoke the token at Google (best effort, never throws for a revoke failure), unregister the providers, drop the tokens and delete the vault entry. Returns `{ result: confirmed \| notConfirmed \| nothingToRevoke, message }`. The settings entry is removed by the caller |
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
- Mark messages as read or unread, star/unstar, archive
- Move messages between Inbox, Spam, Trash and user labels
- Resolve a Drafts-box message to its draft (resume and send in place)
- List email boxes (Inbox, Starred, Sent, Drafts, Spam, Trash)

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
| `markAsUnread(id: string): Promise<void>` | Add the `UNREAD` label |
| `archiveMessage(id: string): Promise<void>` | Remove the `INBOX` label |
| `setStarred(id: string, starred: boolean): Promise<void>` | Add or remove the `STARRED` label (`isStarred` is read from labels) |
| `moveMessage(id: string, box: string): Promise<void>` | `trash` uses the trash endpoint; other boxes add their label and remove the other location labels (`INBOX`/`SPAM`/`TRASH`). User labels are resolved by name; Sent, Drafts and Starred are refused |
| `getDraftByMessageId(messageId: string): Promise<EmailDraft \| undefined>` | Scan `drafts.list` (up to 10 pages) for the draft wrapping a message |
| `deleteMessage(id: string): Promise<void>` | Move a message to the trash (recoverable) |

Search uses Gmail's search syntax: `box` values map to `in:inbox`, `in:sent`, `in:drafts`, `in:spam`, and `in:trash`; other values become `label:<name>`. Messages and drafts are rebuilt as multipart MIME (`text/plain` and/or `text/html`) before upload.

**Scope requirements:**

- `https://www.googleapis.com/auth/gmail.readonly` — listing, reading, and searching messages
- `https://www.googleapis.com/auth/gmail.compose` — creating and updating drafts
- `https://www.googleapis.com/auth/gmail.send` — sending drafts
- `https://www.googleapis.com/auth/gmail.modify` — read/unread, star, archive, move and trash

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
- Create events (timed and all-day, with attendees and status)
- Update events
- Delete events

**Methods:**

| Method | Description |
| --- | --- |
| `getUpcomingEvents(filter: CalendarEventFilterOptions): Promise<ParsedCalendarEvent[]>` | List upcoming events within the time range |
| `searchEvents(filter: CalendarEventSearchOptions): Promise<ParsedCalendarEvent[]>` | Search events by query |
| `createEvent(data: CreateCalendarEventData): Promise<ParsedCalendarEvent>` | Create an event |
| `updateEvent(id: string, data: UpdateCalendarEventData): Promise<ParsedCalendarEvent>` | Patch an event by ID (only the given fields change, so a status- or attendee-only update keeps the rest) |
| `getEventById(id: string): Promise<ParsedCalendarEvent>` | Fetch an event by ID |
| `deleteEvent(id: string): Promise<void>` | Delete an event by ID |

**Scope requirements:**

- `https://www.googleapis.com/auth/calendar` — full access to calendar events

### `GoogleDriveStore`

Google Drive as a remote store. It implements the `RemoteStore` interface from `@tokenring-ai/filesystem` and is registered with `RemoteStoreService` at install time. Drive is not part of the host filesystem: there is no grep, glob, watch or terminal access, and agents copy a file to the host (`remote_download`) when they need those.

**Constructor:**

```typescript
constructor(google: GoogleService)
```

**Store properties:**

```typescript
readonly scheme = "googledrive";
readonly label = "Google Drive";
```

**URLs:**

- Files and folders are named by Drive file ID, `googledrive://<account>/<fileId>`, because Drive allows several files with the same name in one folder.
- `googledrive://<account>/` is the account's configured `rootFolderId` (default `root`, i.e. My Drive).
- Path segments before the last one are ignored, so a URL with a readable prefix still resolves to the final ID.
- `<account>` is the account name from `google.accounts`; an account without `drive` configured is refused.

**Mounts:** `mounts()` returns one mount per account from `GoogleService.getDriveAccounts()`, with `url` `googledrive://<account>/`, `label` `<drive.description> · <account>`, and `writable` / `contextualSearch` taken from the account's `drive` settings.

**Methods:**

| Method | Description |
| --- | --- |
| `mounts(): RemoteMount[]` | One mount per account with Drive configured |
| `list(url, { cursor? }): Promise<RemoteListing>` | List a folder's non-trashed children (folders first, then by name, 200 per page; `cursor` is Drive's `nextPageToken`) |
| `stat(url): Promise<RemoteEntry \| null>` | File metadata; `null` when Drive returns 404 |
| `read(url): Promise<RemoteContent>` | Download a file, or export a Google-native file (see below); folders are refused |
| `search(query, { authority, limit }): Promise<RemoteEntry[]>` | Drive search on `name contains` or `fullText contains` the query (at most 100 results) |
| `create(folderUrl, name, content, mimeType): Promise<RemoteEntry>` | Upload a new file into a folder |
| `update(url, content, mimeType): Promise<RemoteEntry>` | Replace an existing file's content |

All requests set `supportsAllDrives`, so shared drives work. `create` and `update` are only reached through `RemoteStoreService`, which refuses them unless the mount's `writable` is `true`.

**Google-native exports:** Google Docs, Sheets, Slides and Drawings have no bytes of their own, so `read` exports them. The entry's `readsAs` field reports the export type:

| Drive type | Reads as |
| --- | --- |
| Google Doc (`application/vnd.google-apps.document`) | `text/markdown` |
| Google Sheet (`application/vnd.google-apps.spreadsheet`) | `text/csv` |
| Google Slides (`application/vnd.google-apps.presentation`) | `text/plain` |
| Google Drawing (`application/vnd.google-apps.drawing`) | `image/png` |
| Apps Script (`application/vnd.google-apps.script`) | `application/vnd.google-apps.script+json` |

Ordinary files are downloaded as they are.

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
| `install(app)` | Adds `GoogleService` via `app.addService`; waits for `RemoteStoreService` and registers a `GoogleDriveStore`; waits for `AgentCommandService` and registers the three `/google account ...` commands; waits for `WebHostService` and registers `GoogleOAuthCallbackResource` at `/oauth/google/callback` |
| `reconfigure(app, config)` | Resolves the `clientId`/`clientSecret` secret references with `resolveSecret`, then calls `app.requireService(GoogleService).reconfigure(resolved)` — account reconciliation registers or unregisters the Gmail and Calendar providers |

## Integration

The plugin integrates with abstract Token Ring services rather than registering new tools or commands directly. It registers:

- `GoogleService` as a core service
- Gmail providers into `EmailService`, one per account that enables `gmail`
- Google Calendar providers into `CalendarService`, one per account that enables `calendar`
- `GoogleDriveStore` into `RemoteStoreService` (scheme `googledrive`), with one mount per account that enables `drive`
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

```

Drive mounts are addressed by URL rather than provider name: agents use the `remote_list`, `remote_read`, `remote_search`, `remote_download` and `remote_upload` tools, and the web UI's Remote files app (`/remote`) browses them. See the Remote stores section of the `@tokenring-ai/filesystem` README.

The package is typically used alongside `@tokenring-ai/email`, `@tokenring-ai/calendar`, `@tokenring-ai/web-host`, and `@tokenring-ai/vault`. OAuth client credentials are resolved with `@tokenring-ai/secrets` at configure time.

## State Management

`GoogleService` keeps account auth state in memory and persists it to the vault:

- **Token storage** — access and refresh tokens are held per account in memory and written to `VaultService` under the `google` category whenever they change.
- **Profile caching** — the user profile is fetched via the `userinfo.email` scope and cached in memory; it is stored in the vault with the tokens.
- **Token auto-refresh** — the OAuth client refreshes expired access tokens in the background and updates the stored credentials.
- **Session restore** — during `reconfigure`, each account's stored tokens are loaded from the vault so previously authenticated accounts stay authenticated.
- **Provider state** — the Gmail and Calendar providers and the Drive store are stateless. Per-agent provider selection and the current message/draft/event are owned by the abstract packages' state slices (`EmailState`, `CalendarState`).

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

### Google Drive Example

Enable Drive on an account, optionally allowing writes and `@` search:

```yaml
google:
  accounts:
    work:
      email: me@example.com
      drive:
        writable: true
        contextualSearch: true
```

Agents then see `googledrive://work/` in their context and can use the remote tools:

```text
remote_list     { "url": "googledrive://work/" }
remote_read     { "url": "googledrive://work/<fileId>" }        # a Google Doc reads as Markdown
remote_download { "url": "googledrive://work/<fileId>", "path": "/abs/host/path/notes.md" }
remote_upload   { "path": "/abs/host/path/report.pdf", "url": "googledrive://work/<folderId>" }
```

`remote_upload` asks the user for approval and fails on a mount without `writable: true`.

## Best Practices

- Configure a stable `agentDefaults.account` when most providers use the same Google identity
- Use descriptive account names that reflect the identity or purpose (e.g. "primary", "work", "personal")
- Enable only the integrations (`gmail`, `calendar`, `drive`) you need for each account to keep the requested OAuth scopes minimal
- Set the account `email` to the address you expect to authenticate; it is used as the OAuth `login_hint` and as the draft `From` header
- Leave Drive `writable` off unless agents need to upload; uploads are visible to everyone with access to the Drive
- Turn on `contextualSearch` only for Drives you want in `@` search; remote search runs as you type and gives up after 1.5 seconds
- Keep `clientId`/`clientSecret` as env or vault secret references rather than literals in the configuration file

## Testing

```bash
bun test            # from plugin/google
bun test:watch
bun test:coverage
bun run build       # typecheck (tsc --noEmit)
```

The suite runs in a Node environment (`bun.config.ts`). `test/GoogleService.test.ts` covers authorization URL scope selection per enabled integration and an end-to-end OAuth flow through the web-host callback with vault token storage. `test/GmailEmailProvider.test.ts` covers label-derived box listing, paginated message retrieval with header/body parsing, and `markAsRead`. `test/GoogleCalendarProvider.test.ts` covers the Calendar provider. `test/GoogleDriveStore.test.ts` covers mounts, root-folder listing, Google Doc export, plain downloads, missing files, search query quoting, and create/update.

## Dependencies

| Package | Purpose |
| --- | --- |
| `@tokenring-ai/agent` | `AgentCommandService` and agent command types |
| `@tokenring-ai/app` | `TokenRingPlugin`, service registry, `ConfigurationError` |
| `@tokenring-ai/calendar` | `CalendarService` provider registration |
| `@tokenring-ai/email` | `EmailService` provider registration |
| `@tokenring-ai/filesystem` | `RemoteStore` interface, `parseRemoteUrl`, and `RemoteStoreService` registration |
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
| `GoogleDriveStore` | class (default) | Google Drive `RemoteStore` (scheme `googledrive`) |
| `GoogleConfigSchema` | schema | Plugin config schema |
| `GoogleAccountSchema` | schema | Account config schema |
| `GoogleStoredTokenSchema` | schema | Vault token schema |
| `GmailEmailProviderOptionsSchema` | schema | Gmail provider options schema |
| `GoogleCalendarProviderOptionsSchema` | schema | Calendar provider options schema |
| `ParsedGoogleConfig` | type | Parsed config shape (`z.output<typeof GoogleConfigSchema>`) |
| `ResolvedGoogleConfig` | type | Config with OAuth client secrets resolved |

The plugin default export is not re-exported from `index.ts`; import it from the subpath `@tokenring-ai/google/plugin`.

## License

MIT License — see LICENSE file for details.
