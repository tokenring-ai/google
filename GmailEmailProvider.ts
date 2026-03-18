import Agent from "@tokenring-ai/agent/Agent";
import type {DraftEmailData, EmailDraft, EmailInboxFilterOptions, EmailMessage, EmailProvider, EmailSearchOptions} from "@tokenring-ai/email";
import {z} from "zod";
import GoogleService from "./GoogleService.ts";
import {GmailEmailProviderOptionsSchema} from "./schema.ts";

type GmailMessageListResponse = {
  messages?: Array<{id: string; threadId: string}>;
};

type GmailHeader = {name?: string; value?: string};
type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {data?: string; size?: number};
  parts?: GmailPart[];
};
type GmailMessageResponse = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};
type GmailDraftResponse = {
  id: string;
  message?: GmailMessageResponse;
};
type GmailSendResponse = {
  id: string;
  threadId?: string;
  labelIds?: string[];
};

export default class GmailEmailProvider implements EmailProvider {
  description: string;
  private readonly account: string;

  constructor(
    private readonly options: z.output<typeof GmailEmailProviderOptionsSchema>,
    private readonly googleService: GoogleService,
  ) {
    this.description = options.description;
    this.account = options.account;
  }

  async getInboxMessages(filter: EmailInboxFilterOptions, agent: Agent): Promise<EmailMessage[]> {
    const queryParts = ["in:inbox"];
    if (filter.unreadOnly) queryParts.push("is:unread");
    return await this.listMessages(queryParts.join(" "), filter.limit ?? 25, agent);
  }

  async searchMessages(filter: EmailSearchOptions, agent: Agent): Promise<EmailMessage[]> {
    const queryParts = [filter.query];
    if (filter.unreadOnly) queryParts.push("is:unread");
    return await this.listMessages(queryParts.join(" ").trim(), filter.limit ?? 25, agent);
  }

  async getMessageById(id: string, agent: Agent): Promise<EmailMessage> {
    return await this.getMessage(id);
  }

  async createDraft(data: DraftEmailData, agent: Agent): Promise<EmailDraft> {
    const raw = this.encodeBase64Url(this.buildMimeMessage(data));
    const response = await this.googleService.fetchGoogleJson<GmailDraftResponse>(
      this.account,
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        body: JSON.stringify({
          message: {
            raw,
            threadId: data.threadId,
          },
        }),
      },
      "create Gmail draft",
    );

    return this.gmailDraftToEmailDraft(response, data);
  }

  async updateDraft(data: EmailDraft, agent: Agent): Promise<EmailDraft> {
    const raw = this.encodeBase64Url(this.buildMimeMessage(data));
    const response = await this.googleService.fetchGoogleJson<GmailDraftResponse>(
      this.account,
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${data.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          id: data.id,
          message: {
            raw,
            threadId: data.threadId,
          },
        }),
      },
      "update Gmail draft",
    );

    return this.gmailDraftToEmailDraft(response, data);
  }

  async sendDraft(id: string, agent: Agent): Promise<void> {
    await this.googleService.fetchGoogleJson<GmailSendResponse>(
      this.account,
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
      {
        method: "POST",
        body: JSON.stringify({id}),
      },
      "send Gmail draft",
    );
  }

  private async listMessages(query: string, limit: number, agent: Agent): Promise<EmailMessage[]> {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", limit.toString());
    if (query) url.searchParams.set("q", query);

    const list = await this.googleService.fetchGoogleJson<GmailMessageListResponse>(
      this.account,
      url.toString(),
      {method: "GET"},
      "list Gmail messages",
    );

    const messageIds = list.messages ?? [];
    const messages = await Promise.all(messageIds.map(message => this.getMessage(message.id)));

    agent.infoMessage(`[gmail] Loaded ${messages.length} messages for account ${this.account}`);
    return messages;
  }

  private async getMessage(id: string): Promise<EmailMessage> {
    const response = await this.googleService.fetchGoogleJson<GmailMessageResponse>(
      this.account,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      {method: "GET"},
      `fetch Gmail message ${id}`,
    );

    return this.gmailMessageToEmailMessage(response);
  }

  private gmailMessageToEmailMessage(message: GmailMessageResponse): EmailMessage {
    const headers = this.collectHeaders(message.payload);
    const subject = this.getHeader(headers, "Subject") ?? "(no subject)";
    const from = this.parseAddress(this.getHeader(headers, "From"));
    const to = this.parseAddressList(this.getHeader(headers, "To"));
    const cc = this.parseAddressList(this.getHeader(headers, "Cc"));
    const bcc = this.parseAddressList(this.getHeader(headers, "Bcc"));
    const textBody = this.extractBody(message.payload, "text/plain");
    const htmlBody = this.extractBody(message.payload, "text/html");
    const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();

    return {
      id: message.id,
      threadId: message.threadId,
      subject,
      from,
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      snippet: message.snippet,
      textBody,
      htmlBody,
      labels: message.labelIds,
      isRead: !(message.labelIds ?? []).includes("UNREAD"),
      receivedAt,
      sentAt: this.parseDateHeader(this.getHeader(headers, "Date")) ?? receivedAt,
    };
  }

  private gmailDraftToEmailDraft(response: GmailDraftResponse, fallback: DraftEmailData): EmailDraft {
    const message = response.message;
    const now = new Date();
    const parsedMessage = message ? this.gmailMessageToEmailMessage(message) : undefined;

    return {
      id: response.id,
      threadId: message?.threadId ?? fallback.threadId,
      subject: parsedMessage?.subject ?? fallback.subject,
      to: parsedMessage?.to ?? fallback.to,
      cc: parsedMessage?.cc ?? fallback.cc,
      bcc: parsedMessage?.bcc ?? fallback.bcc,
      textBody: parsedMessage?.textBody ?? fallback.textBody,
      htmlBody: parsedMessage?.htmlBody ?? fallback.htmlBody,
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildMimeMessage(data: DraftEmailData): string {
    const from = this.googleService.getUserEmail(this.account);
    const headers = [
      `From: ${from}`,
      `To: ${this.formatAddressList(data.to)}`,
    ];

    if (data.cc?.length) headers.push(`Cc: ${this.formatAddressList(data.cc)}`);
    if (data.bcc?.length) headers.push(`Bcc: ${this.formatAddressList(data.bcc)}`);
    if (data.threadId) headers.push(`References: ${data.threadId}`);
    headers.push(`Subject: ${data.subject}`);
    headers.push("MIME-Version: 1.0");

    if (data.textBody && data.htmlBody) {
      const boundary = `tokenring-${Date.now()}`;
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      return [
        ...headers,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        data.textBody,
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "",
        data.htmlBody,
        `--${boundary}--`,
        "",
      ].join("\r\n");
    }

    headers.push(`Content-Type: ${data.htmlBody ? "text/html" : "text/plain"}; charset=UTF-8`);
    return [
      ...headers,
      "",
      data.htmlBody ?? data.textBody ?? "",
    ].join("\r\n");
  }

  private encodeBase64Url(value: string): string {
    return Buffer.from(value, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  private decodeBase64Url(value: string): string {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
  }

  private collectHeaders(part?: GmailPart): GmailHeader[] {
    if (!part) return [];
    return [...(part.headers ?? []), ...(part.parts ?? []).flatMap(child => this.collectHeaders(child))];
  }

  private getHeader(headers: GmailHeader[], name: string): string | undefined {
    return headers.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value;
  }

  private extractBody(part: GmailPart | undefined, mimeType: string): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === mimeType && part.body?.data) {
      return this.decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) {
      const body = this.extractBody(child, mimeType);
      if (body) return body;
    }
    return undefined;
  }

  private parseAddress(value?: string): {email: string; name?: string} {
    const [address] = this.parseAddressList(value);
    return address ?? {email: this.googleService.getUserEmail(this.account)};
  }

  private parseAddressList(value?: string): Array<{email: string; name?: string}> {
    if (!value) return [];
    return value
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const match = item.match(/^(.*)<([^>]+)>$/);
        if (!match) return {email: item.replace(/^"|"$/g, "")};
        const name = match[1].trim().replace(/^"|"$/g, "");
        return {email: match[2].trim(), name: name || undefined};
      });
  }

  private formatAddressList(addresses: Array<{email: string; name?: string}>): string {
    return addresses.map(address => address.name ? `${address.name} <${address.email}>` : address.email).join(", ");
  }

  private parseDateHeader(value?: string): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}
