import { beforeEach, describe, expect, it, mock } from "bun:test";
import GmailEmailProvider from "../GmailEmailProvider.ts";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("GmailEmailProvider", () => {
  let googleService: {
    getAccountStatus: ReturnType<typeof mock>;
    getUserEmail: ReturnType<typeof mock>;
    withGmail: ReturnType<typeof mock>;
    requireUserEmail: ReturnType<typeof mock>;
  };
  let gmailApi: {
    users: {
      labels: { list: ReturnType<typeof mock> };
      drafts: {
        create: ReturnType<typeof mock>;
        get: ReturnType<typeof mock>;
        list: ReturnType<typeof mock>;
        update: ReturnType<typeof mock>;
      };
      messages: {
        get: ReturnType<typeof mock>;
        list: ReturnType<typeof mock>;
        modify: ReturnType<typeof mock>;
        trash: ReturnType<typeof mock>;
      };
    };
  };
  let provider: GmailEmailProvider;

  beforeEach(() => {
    googleService = {
      getAccountStatus: mock(() => ({
        account: { email: "me@example.com" },
        profile: { email: "me@example.com" },
        isAuthenticated: true,
      })),
      getUserEmail: mock(),
      withGmail: mock(),
      requireUserEmail: mock(),
    };
    gmailApi = {
      users: {
        labels: {
          list: mock(),
        },
        drafts: {
          create: mock(),
          get: mock(),
          list: mock(),
          update: mock(),
        },
        messages: {
          get: mock(),
          list: mock(),
          modify: mock(),
          trash: mock(),
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
      { id: "starred", name: "Starred" },
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

  it("pages a search with the page token and returns the next one", async () => {
    gmailApi.users.messages.list.mockImplementationOnce(async request => {
      expect(request.q).toBe("budget in:inbox");
      expect(request.pageToken).toBe("search-1");
      return { data: { messages: [], nextPageToken: "search-2" } };
    });

    await expect(provider.searchMessagePage({ query: "budget", box: "inbox", pageToken: "search-1" })).resolves.toEqual({
      messages: [],
      nextPageToken: "search-2",
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

  it("deletes a message by moving it to the Gmail trash", async () => {
    gmailApi.users.messages.trash.mockImplementationOnce(async request => {
      expect(request).toEqual({
        id: "message-1",
        userId: "me",
      });
      return { data: { id: "message-1", labelIds: ["TRASH"] } };
    });

    await expect(provider.deleteMessage("message-1")).resolves.toBeUndefined();
    expect(gmailApi.users.messages.trash).toHaveBeenCalledTimes(1);
    // Trash is recoverable; the message must not be purged.
    expect(gmailApi.users.messages.modify).not.toHaveBeenCalled();
  });

  it("re-fetches a draft after update so the returned payload is not a stub", async () => {
    gmailApi.users.drafts.update.mockResolvedValueOnce({
      data: {
        id: "draft-1",
        message: { id: "msg-1", threadId: "thread-1", labelIds: ["DRAFT"] },
      },
    });
    gmailApi.users.drafts.get.mockImplementationOnce(async request => {
      expect(request).toMatchObject({
        format: "full",
        id: "draft-1",
        userId: "me",
      });
      return {
        data: {
          id: "draft-1",
          message: {
            id: "msg-1",
            threadId: "thread-1",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Updated subject" },
                { name: "From", value: "me@example.com" },
                { name: "To", value: "bob@example.com" },
              ],
              body: { data: encodeBase64Url("Updated body") },
            },
          },
        },
      };
    });

    await expect(
      provider.updateDraft({
        id: "draft-1",
        threadId: "thread-1",
        subject: "Updated subject",
        to: [{ email: "bob@example.com" }],
        textBody: "Updated body",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).resolves.toMatchObject({
      id: "draft-1",
      threadId: "thread-1",
      subject: "Updated subject",
      to: [{ email: "bob@example.com" }],
      textBody: "Updated body",
    });
    expect(gmailApi.users.drafts.update).toHaveBeenCalledTimes(1);
    expect(gmailApi.users.drafts.get).toHaveBeenCalledTimes(1);
  });

  describe("mailbox operations", () => {
    it("marks a message unread by adding the UNREAD label", async () => {
      gmailApi.users.messages.modify.mockResolvedValueOnce({ data: {} });
      await provider.markAsUnread("message-1");
      expect(gmailApi.users.messages.modify).toHaveBeenCalledWith({ id: "message-1", userId: "me", requestBody: { addLabelIds: ["UNREAD"] } });
    });

    it("archives by removing the INBOX label", async () => {
      gmailApi.users.messages.modify.mockResolvedValueOnce({ data: {} });
      await provider.archiveMessage("message-1");
      expect(gmailApi.users.messages.modify).toHaveBeenCalledWith({ id: "message-1", userId: "me", requestBody: { removeLabelIds: ["INBOX"] } });
    });

    it("stars and unstars through the STARRED label", async () => {
      gmailApi.users.messages.modify.mockResolvedValue({ data: {} });
      await provider.setStarred("message-1", true);
      await provider.setStarred("message-1", false);
      expect(gmailApi.users.messages.modify.mock.calls.map(call => (call[0] as { requestBody: unknown }).requestBody)).toEqual([
        { addLabelIds: ["STARRED"] },
        { removeLabelIds: ["STARRED"] },
      ]);
    });

    it("reports starred messages from their labels", async () => {
      gmailApi.users.messages.get.mockResolvedValueOnce({
        data: { id: "m", labelIds: ["INBOX", "STARRED"], payload: { mimeType: "text/plain", headers: [], body: {} } },
      });
      await expect(provider.getMessageById("m")).resolves.toMatchObject({ isStarred: true, isRead: true });
    });

    it("moves to a system box by swapping location labels", async () => {
      gmailApi.users.messages.modify.mockResolvedValueOnce({ data: {} });
      await provider.moveMessage("message-1", "spam");
      expect(gmailApi.users.messages.modify).toHaveBeenCalledWith({
        id: "message-1",
        userId: "me",
        requestBody: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "TRASH"] },
      });
    });

    it("moves to the trash through the recoverable trash endpoint", async () => {
      gmailApi.users.messages.trash.mockResolvedValueOnce({ data: {} });
      await provider.moveMessage("message-1", "Trash");
      expect(gmailApi.users.messages.trash).toHaveBeenCalledWith({ id: "message-1", userId: "me" });
      expect(gmailApi.users.messages.modify).not.toHaveBeenCalled();
    });

    it("resolves a user label by name when moving", async () => {
      gmailApi.users.labels.list.mockResolvedValueOnce({ data: { labels: [{ id: "Label_7", name: "Receipts", type: "user" }] } });
      gmailApi.users.messages.modify.mockResolvedValueOnce({ data: {} });
      await provider.moveMessage("message-1", "receipts");
      expect(gmailApi.users.messages.modify).toHaveBeenCalledWith({
        id: "message-1",
        userId: "me",
        requestBody: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX", "SPAM", "TRASH"] },
      });
    });

    it("refuses to move into view-only boxes or unknown labels", async () => {
      await expect(provider.moveMessage("message-1", "sent")).rejects.toThrow(/cannot be moved/);
      gmailApi.users.labels.list.mockResolvedValueOnce({ data: { labels: [] } });
      await expect(provider.moveMessage("message-1", "Nope")).rejects.toThrow(/no mailbox or label/);
      expect(gmailApi.users.messages.modify).not.toHaveBeenCalled();
    });
  });

  describe("getDraftByMessageId", () => {
    it("finds the draft behind a Drafts-box message across pages", async () => {
      gmailApi.users.drafts.list
        .mockResolvedValueOnce({ data: { drafts: [{ id: "d1", message: { id: "other" } }], nextPageToken: "p2" } })
        .mockResolvedValueOnce({ data: { drafts: [{ id: "d2", message: { id: "msg-2" } }] } });
      gmailApi.users.drafts.get.mockResolvedValueOnce({
        data: {
          id: "d2",
          message: {
            id: "msg-2",
            threadId: "t2",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Half written" },
                { name: "To", value: "bob@example.com" },
              ],
              body: { data: encodeBase64Url("So far") },
            },
          },
        },
      });

      await expect(provider.getDraftByMessageId("msg-2")).resolves.toMatchObject({
        id: "d2",
        threadId: "t2",
        subject: "Half written",
        to: [{ email: "bob@example.com" }],
        textBody: "So far",
      });
      expect(gmailApi.users.drafts.list.mock.calls[1]![0]).toMatchObject({ pageToken: "p2" });
    });

    it("resolves undefined when the message is not a draft", async () => {
      gmailApi.users.drafts.list.mockResolvedValueOnce({ data: { drafts: [] } });
      await expect(provider.getDraftByMessageId("msg-x")).resolves.toBeUndefined();
    });
  });
});
