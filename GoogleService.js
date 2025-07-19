import { Service } from "@token-ring/registry";
import { google } from 'googleapis';

export default class GoogleService extends Service {
 name = "GoogleService";
 description = "Provides Google functionality";
 static constructorProperties = {
  clientId: {
   type: "string",
   required: true,
   description: "OAuth2 client ID for Gmail API"
  },
  clientSecret: {
   type: "string",
   required: true,
   description: "OAuth2 client secret for Gmail API"
  },
  refreshToken: {
   type: "string",
   required: true,
   description: "OAuth2 refresh token for Gmail API"
  },
  userEmail: {
   type: "string",
   required: true,
   description: "Email address of the Gmail user"
  }
 };

 constructor({ clientId, clientSecret, refreshToken, userEmail }) {
  super();
  if (!clientId) throw new Error("GmailBotService requires clientId.");
  if (!clientSecret) throw new Error("GmailBotService requires clientSecret.");
  if (!refreshToken) throw new Error("GmailBotService requires refreshToken.");
  if (!userEmail) throw new Error("GmailBotService requires userEmail.");

  this.clientId = clientId;
  this.clientSecret = clientSecret;
  this.refreshToken = refreshToken;
  this.userEmail = userEmail;
  this.oauth2Client = null;
  this.driveClient = null;
 }

 _initializeOAuthClient() {
  if (this.oauth2Client) {
    return this.oauth2Client;
  }
  this.oauth2Client = new google.auth.OAuth2(
    this.clientId,
    this.clientSecret,
    // this.redirectUri // Redirect URI is typically for web flow, not needed for server-to-server with refresh token
  );
  this.oauth2Client.setCredentials({
    refresh_token: this.refreshToken,
    // Potentially set access_token and expiry_date if you have them and want to manage them manually
    // However, the library can often auto-refresh with a refresh token.
  });
  // TODO: Handle token refresh listeners or explicit refresh if needed,
  // though googleapis library often handles this transparently with a refresh token.
  // Example:
  // this.oauth2Client.on('tokens', (tokens) => {
  //   if (tokens.access_token) {
  //     console.log('GoogleService: Access token refreshed.');
  //     // Persist new tokens if necessary (e.g., if refresh token also changes)
  //   }
  // });
  return this.oauth2Client;
}

 getDriveClient() {
  if (this.driveClient) {
    return this.driveClient;
  }
  this._initializeOAuthClient(); // Ensure OAuth2 client is ready
  this.driveClient = google.drive({
    version: 'v3',
    auth: this.oauth2Client,
  });
  if (!this.driveClient) {
    throw new Error('Failed to initialize Google Drive client.');
  }
  return this.driveClient;
}

 getClientId() {
  return this.clientId;
 }

 getClientSecret() {
  return this.clientSecret;
 }

 getRefreshToken() {
  return this.refreshToken;
 }

 getUserEmail() {
  return this.userEmail;
 }


 async start(registry) {
  // Initialize service
  console.log("GoogleService starting");
 }

 async stop(registry) {
  // Clean up service
  console.log("GoogleService stopping");
 }

 /**
  * Reports the status of the service.
  * @param {TokenRingRegistry} registry - The package registry
  * @returns {Object} Status information.
  */
 async status(registry) {
  return {
   active: true,
   service: "GoogleService"
  };
 }}
