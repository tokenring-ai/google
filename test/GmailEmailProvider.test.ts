import {beforeEach, describe, expect, it, vi} from "vitest";
import GmailEmailProvider from "../GmailEmailProvider.ts";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("GmailEmailProvider", () => {
  let googleService: {
    fetchGoogleJson: ReturnType<typeof vi.fn>;
    requireUserEmail: ReturnType<typeof vi.fn>;
  };
  let provider: GmailEmailProvider;

  beforeEach(() => {
    googleService = {
      fetchGoogleJson: vi.fn(),
      requireUserEmail: vi.fn(),
    };
    provider = new GmailEmailProvider({
      description: "Primary Gmail",
      account: "primary",
    }, googleService as never);
  });

  it("lists supported email boxes from Gmail labels", async () => {
    googleService.fetchGoogleJson.mockResolvedValueOnce({
      labels: [
        {id: "INBOX", name: "INBOX", type: "system"},
        {id: "STARRED", name: "STARRED", type: "system"},
        {id: "SENT", name: "SENT", type: "system"},
      ],
    });

    await expect(provider.listBoxes()).resolves.toEqual([
      {id: "inbox", name: "Inbox"},
      {id: "sent", name: "Sent"},
    ]);
  });

  it("returns paginated messages for the requested box", async () => {
    googleService.fetchGoogleJson
      .mockImplementationOnce(async (_account: string, url: string) => {
        const parsed = new URL(url);

        expect(parsed.searchParams.get("q")).toBe("in:sent is:unread");
        expect(parsed.searchParams.get("maxResults")).toBe("10");
        expect(parsed.searchParams.get("pageToken")).toBe("page-1");

        return {
          messages: [{id: "message-1", threadId: "thread-1"}],
          nextPageToken: "page-2",
        };
      })
      .mockResolvedValueOnce({
        id: "message-1",
        threadId: "thread-1",
        internalDate: "1700000000000",
        labelIds: ["SENT"],
        payload: {
          mimeType: "text/plain",
          headers: [
            {name: "Subject", value: "Status update"},
            {name: "From", value: "Alice <alice@example.com>"},
            {name: "To", value: "Bob <bob@example.com>"},
            {name: "Date", value: "Tue, 14 Nov 2023 12:00:00 +0000"},
          ],
          body: {
            data: encodeBase64Url("Latest status"),
          },
        },
      });

    await expect(provider.getMessages({
      box: "sent",
      limit: 10,
      unreadOnly: true,
      pageToken: "page-1",
    })).resolves.toMatchObject({
      nextPageToken: "page-2",
      messages: [
        {
          id: "message-1",
          subject: "Status update",
          isRead: true,
          snippet: undefined,
        },
      ],
    });
  });
});
