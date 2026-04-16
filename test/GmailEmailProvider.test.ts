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
    getUserEmail: ReturnType<typeof vi.fn>;
    withGmail: ReturnType<typeof vi.fn>;
    requireUserEmail: ReturnType<typeof vi.fn>;
  };
  let gmailApi: {
    users: {
      labels: {list: ReturnType<typeof vi.fn>};
      messages: {
        get: ReturnType<typeof vi.fn>;
        list: ReturnType<typeof vi.fn>;
      };
    };
  };
  let provider: GmailEmailProvider;

  beforeEach(() => {
    googleService = {
      getUserEmail: vi.fn(),
      withGmail: vi.fn(),
      requireUserEmail: vi.fn(),
    };
    gmailApi = {
      users: {
        labels: {
          list: vi.fn(),
        },
        messages: {
          get: vi.fn(),
          list: vi.fn(),
        },
      },
    };
    googleService.withGmail.mockImplementation(
      async (
        _account: string,
        _request: unknown,
        callback: (gmail: typeof gmailApi) => Promise<unknown>,
      ) => await callback(gmailApi),
    );
    provider = new GmailEmailProvider({
      description: "Primary Gmail",
      account: "primary",
    }, googleService as never);
  });

  it("lists supported email boxes from Gmail labels", async () => {
    gmailApi.users.labels.list.mockResolvedValueOnce({
      data: {
        labels: [
          {id: "INBOX", name: "INBOX", type: "system"},
          {id: "STARRED", name: "STARRED", type: "system"},
          {id: "SENT", name: "SENT", type: "system"},
        ],
      },
    });

    await expect(provider.listBoxes()).resolves.toEqual([
      {id: "inbox", name: "Inbox"},
      {id: "sent", name: "Sent"},
    ]);
  });

  it("returns paginated messages for the requested box", async () => {
    gmailApi.users.messages.list.mockImplementationOnce(async (request) => {
      expect(request.q).toBe("in:sent is:unread");
      expect(request.maxResults).toBe(10);
      expect(request.pageToken).toBe("page-1");

      return {
        data: {
          messages: [{id: "message-1", threadId: "thread-1"}],
          nextPageToken: "page-2",
        },
      };
    });
    gmailApi.users.messages.get.mockResolvedValueOnce({
      data: {
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
