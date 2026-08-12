import { beforeEach, describe, expect, it, mock } from "bun:test";
import GmailEmailProvider from "../GmailEmailProvider.ts";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("GmailEmailProvider", () => {
  let googleService: {
    getUserEmail: ReturnType<typeof mock>;
    withGmail: ReturnType<typeof mock>;
    requireUserEmail: ReturnType<typeof mock>;
  };
  let gmailApi: {
    users: {
      labels: { list: ReturnType<typeof mock> };
      messages: {
        get: ReturnType<typeof mock>;
        list: ReturnType<typeof mock>;
        modify: ReturnType<typeof mock>;
      };
    };
  };
  let provider: GmailEmailProvider;

  beforeEach(() => {
    googleService = {
      getUserEmail: mock(),
      withGmail: mock(),
      requireUserEmail: mock(),
    };
    gmailApi = {
      users: {
        labels: {
          list: mock(),
        },
        messages: {
          get: mock(),
          list: mock(),
          modify: mock(),
        },
      },
    };
    googleService.withGmail.mockImplementation(
      async (_account: string, _request: unknown, callback: (gmail: typeof gmailApi) => Promise<unknown>) => await callback(gmailApi),
    );
    provider = new GmailEmailProvider(
      {
        description: "Primary Gmail",
        account: "primary",
      },
      googleService as never,
    );
  });

  it("lists supported email boxes from Gmail labels", async () => {
    gmailApi.users.labels.list.mockResolvedValueOnce({
      data: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "STARRED", name: "STARRED", type: "system" },
          { id: "SENT", name: "SENT", type: "system" },
        ],
      },
    });

    expect(provider.listBoxes()).resolves.toEqual([
      { id: "inbox", name: "Inbox" },
      { id: "sent", name: "Sent" },
    ]);
  });

  it("returns paginated messages for the requested box", async () => {
    gmailApi.users.messages.list.mockImplementationOnce(async request => {
      expect(request.q).toBe("in:sent is:unread");
      expect(request.maxResults).toBe(10);
      expect(request.pageToken).toBe("page-1");

      return {
        data: {
          messages: [{ id: "message-1", threadId: "thread-1" }],
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
            { name: "Subject", value: "Status update" },
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "To", value: "Bob <bob@example.com>" },
            { name: "Date", value: "Tue, 14 Nov 2023 12:00:00 +0000" },
          ],
          body: {
            data: encodeBase64Url("Latest status"),
          },
        },
      },
    });

    await expect(
      provider.getMessages({
        box: "sent",
        limit: 10,
        unreadOnly: true,
        pageToken: "page-1",
      }),
    ).resolves.toMatchObject({
      nextPageToken: "page-2",
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
          subject: "Status update",
          isRead: true,
          from: { name: "Alice", email: "alice@example.com" },
          to: [{ name: "Bob", email: "bob@example.com" }],
          textBody: "Latest status",
          labels: ["SENT"],
          receivedAt: 1700000000000,
          sentAt: new Date("Tue, 14 Nov 2023 12:00:00 +0000").getTime(),
        },
      ],
    });
  });

  it("marks a message as read by removing the UNREAD label", async () => {
    gmailApi.users.messages.modify.mockImplementationOnce(async request => {
      expect(request).toEqual({
        id: "message-1",
        userId: "me",
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });
      return { data: {} };
    });

    await expect(provider.markAsRead("message-1")).resolves.toBeUndefined();
    expect(gmailApi.users.messages.modify).toHaveBeenCalledTimes(1);
  });
});
