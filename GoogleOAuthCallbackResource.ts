import type {BunRouter, WebResource} from "../web-host/types.ts";
import type GoogleService from "./GoogleService.ts";
import {GOOGLE_OAUTH_CALLBACK_PATH} from "./GoogleService.ts";

function renderHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f4f5;
        color: #18181b;
        font-family: sans-serif;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 1rem;
        box-shadow: 0 10px 30px rgba(24, 24, 27, 0.08);
      }
      h1 {
        margin-top: 0;
      }
      p:last-child {
        margin-bottom: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

export default class GoogleOAuthCallbackResource implements WebResource {
  constructor(private readonly googleService: GoogleService) {
  }

  register(router: BunRouter): Promise<void> {
    router.get(GOOGLE_OAUTH_CALLBACK_PATH, (request, response) => {
      try {
        this.googleService.completePendingAuthorization(request.url);
        return response.html(
          renderHtml(
            "Google account connected",
            "Authentication completed. You can close this tab and return to TokenRing.",
          ),
        );
      } catch (error: unknown) {
        return response.html(
          renderHtml(
            "Google authentication failed",
            (error as Error).message || "The callback could not be processed.",
          ),
          400,
        );
      }
    });
    return Promise.resolve();
  }
}
