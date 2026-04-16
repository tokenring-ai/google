import type {
  DraftEmailData,
  EmailBox,
  EmailDraft,
  EmailMessage,
  EmailMessagePage,
  EmailMessageQueryOptions,
  EmailProvider,
  EmailSearchOptions,
} from "@tokenring-ai/email";
import type {z} from "zod";
import type GoogleService from "./GoogleService.ts";
import type {GmailEmailProviderOptionsSchema} from "./schema.ts";

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
};

type GmailLabelListResponse = {
  labels?: Array<{
    id: string;
    name: string;
    type?: "system" | "user";
  }>;
};

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
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

const gmailSystemBoxes = [
  {id: "inbox", name: "Inbox", query: "in:inbox", labelName: "INBOX"},
  {id: "sent", name: "Sent", query: "in:sent", labelName: "SENT"},
  {id: "drafts", name: "Drafts", query: "in:drafts", labelName: "DRAFT"},
  {id: "spam", name: "Spam", query: "in:spam", labelName: "SPAM"},
  {id: "trash", name: "Trash", query: "in:trash", labelName: "TRASH"},
] as const;
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

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

  async listBoxes(): Promise<EmailBox[]> {
    const response = await this.googleService.withGmail<GmailLabelListResponse>(
      this.account,
      {
        context: "list Gmail labels",
        requiredScopes: [GMAIL_READ_SCOPE],
      },
      async (gmail) => {
        const {data} = await gmail.users.labels.list({userId: "me"});
        return data as GmailLabelListResponse;
      },
    );

    const availableLabelNames = new Set(
      (response.labels ?? []).map((label) => label.name),
    );
    return gmailSystemBoxes
      .filter((box) => availableLabelNames.has(box.labelName))
      .map(({id, name}) => ({id, name}));
  }

  async getMessages(
    filter: EmailMessageQueryOptions,
  ): Promise<EmailMessagePage> {
    const queryParts = [this.getBoxQuery(filter.box ?? "inbox")];
    if (filter.unreadOnly) queryParts.push("is:unread");
    return await this.listMessages(
      queryParts.filter(Boolean).join(" "),
      filter.limit ?? 25,
      filter.pageToken,
    );
  }

  async searchMessages(filter: EmailSearchOptions): Promise<EmailMessage[]> {
    const queryParts = [filter.query, this.getBoxQuery(filter.box ?? "inbox")];
    if (filter.unreadOnly) queryParts.push("is:unread");
    const page = await this.listMessages(
      queryParts.filter(Boolean).join(" ").trim(),
      filter.limit ?? 25,
    );
    return page.messages;
  }

  async getMessageById(id: string): Promise<EmailMessage> {
    return await this.getMessage(id);
  }

  async createDraft(data: DraftEmailData): Promise<EmailDraft> {
    const raw = this.encodeBase64Url(await this.buildMimeMessage(data));
    const response = await this.googleService.withGmail<GmailDraftResponse>(
      this.account,
      {
        context: "create Gmail draft",
        requiredScopes: [GMAIL_COMPOSE_SCOPE],
      },
      async (gmail) => {
        const {data: responseData} = await gmail.users.drafts.create({
          requestBody: {
            message: {
              raw,
              threadId: data.threadId,
            },
          },
          userId: "me",
        });
        return responseData as GmailDraftResponse;
      },
    );

    return this.gmailDraftToEmailDraft(response, data);
  }

  async updateDraft(data: EmailDraft): Promise<EmailDraft> {
    const raw = this.encodeBase64Url(await this.buildMimeMessage(data));
    const response = await this.googleService.withGmail<GmailDraftResponse>(
      this.account,
      {
        context: "update Gmail draft",
        requiredScopes: [GMAIL_COMPOSE_SCOPE],
      },
      async (gmail) => {
        const {data: responseData} = await gmail.users.drafts.update({
          id: data.id,
          requestBody: {
            id: data.id,
            message: {
              raw,
              threadId: data.threadId,
            },
          },
          userId: "me",
        });
        return responseData as GmailDraftResponse;
      },
    );

    return this.gmailDraftToEmailDraft(response, data);
  }

  async sendDraft(id: string): Promise<void> {
    await this.googleService.withGmail<GmailSendResponse>(
      this.account,
      {
        context: "send Gmail draft",
        requiredScopes: [GMAIL_SEND_SCOPE],
      },
      async (gmail) => {
        const {data} = await gmail.users.drafts.send({
          requestBody: {id},
          userId: "me",
        });
        return data as GmailSendResponse;
      },
    );
  }

  private async listMessages(
    query: string,
    limit: number,
    pageToken?: string,
  ): Promise<EmailMessagePage> {
    const list = await this.googleService.withGmail<GmailMessageListResponse>(
      this.account,
      {
        context: "list Gmail messages",
        requiredScopes: [GMAIL_READ_SCOPE],
      },
      async (gmail) => {
        const {data} = await gmail.users.messages.list({
          maxResults: limit,
          pageToken,
          q: query || undefined,
          userId: "me",
        });
        return data as GmailMessageListResponse;
      },
    );

    const messageIds = list.messages ?? [];
    const messages = await Promise.all(
      messageIds.map((message) => this.getMessage(message.id)),
    );

    return {
      messages,
      nextPageToken: list.nextPageToken,
    };
  }

  private async getMessage(id: string): Promise<EmailMessage> {
    const response = await this.googleService.withGmail<GmailMessageResponse>(
      this.account,
      {
        context: `fetch Gmail message ${id}`,
        requiredScopes: [GMAIL_READ_SCOPE],
      },
      async (gmail) => {
        const {data} = await gmail.users.messages.get({
          format: "full",
          id,
          userId: "me",
        });
        return data as GmailMessageResponse;
      },
    );

    return this.gmailMessageToEmailMessage(response);
  }

  private gmailMessageToEmailMessage(
    message: GmailMessageResponse,
  ): EmailMessage {
    const headers = this.collectHeaders(message.payload);
    const subject = this.getHeader(headers, "Subject") ?? "(no subject)";
    const from = this.parseAddress(this.getHeader(headers, "From"));
    const to = this.parseAddressList(this.getHeader(headers, "To"));
    const cc = this.parseAddressList(this.getHeader(headers, "Cc"));
    const bcc = this.parseAddressList(this.getHeader(headers, "Bcc"));
    const textBody = this.extractBody(message.payload, "text/plain");
    const htmlBody = this.extractBody(message.payload, "text/html");
    const receivedAt = message.internalDate
      ? new Date(Number(message.internalDate))
      : new Date();

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
      sentAt:
        this.parseDateHeader(this.getHeader(headers, "Date")) ?? receivedAt,
    };
  }

  private gmailDraftToEmailDraft(
    response: GmailDraftResponse,
    fallback: DraftEmailData,
  ): EmailDraft {
    const message = response.message;
    const now = new Date();
    const parsedMessage = message
      ? this.gmailMessageToEmailMessage(message)
      : undefined;

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
    const {profile, account} = this.googleService.getAccountStatus(this.account);

    const headers = [`From: ${profile?.email ?? account.email}`, `To: ${this.formatAddressList(data.to)}`];

    if (data.cc?.length) headers.push(`Cc: ${this.formatAddressList(data.cc)}`);
    if (data.bcc?.length)
      headers.push(`Bcc: ${this.formatAddressList(data.bcc)}`);
    if (data.threadId) headers.push(`References: ${data.threadId}`);
    headers.push(`Subject: ${data.subject}`);
    headers.push("MIME-Version: 1.0");

    if (data.textBody && data.htmlBody) {
      const boundary = `tokenring-${Date.now()}`;
      headers.push(
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      );
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

    headers.push(
      `Content-Type: ${data.htmlBody ? "text/html" : "text/plain"}; charset=UTF-8`,
    );
    return [...headers, "", data.htmlBody ?? data.textBody ?? ""].join("\r\n");
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
    const padding =
      normalized.length % 4 === 0
        ? ""
        : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
  }

  private getBoxQuery(box: string): string {
    const normalizedBox = box.trim().toLowerCase();
    const systemBox = gmailSystemBoxes.find(
      (candidate) => candidate.id === normalizedBox,
    );
    if (systemBox) return systemBox.query;

    return `label:${this.escapeGmailQueryValue(box)}`;
  }

  private escapeGmailQueryValue(value: string): string {
    return JSON.stringify(value.trim());
  }

  private collectHeaders(part?: GmailPart): GmailHeader[] {
    if (!part) return [];
    return [
      ...(part.headers ?? []),
      ...(part.parts ?? []).flatMap((child) => this.collectHeaders(child)),
    ];
  }

  private getHeader(headers: GmailHeader[], name: string): string | undefined {
    return headers.find(
      (header) => header.name?.toLowerCase() === name.toLowerCase(),
    )?.value;
  }

  private extractBody(
    part: GmailPart | undefined,
    mimeType: string,
  ): string | undefined {
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

  private parseAddress(value?: string): { email: string; name?: string } {
    const [address] = this.parseAddressList(value);

    return (
      address ?? {
        email: "unknown",
      }
    );
  }

  private parseAddressList(
    value?: string,
  ): Array<{ email: string; name?: string }> {
    if (!value) return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const match = item.match(/^(.*)<([^>]+)>$/);
        if (!match) return {email: item.replace(/^"|"$/g, "")};
        const name = match[1].trim().replace(/^"|"$/g, "");
        return {email: match[2].trim(), name: name || undefined};
      });
  }

  private formatAddressList(
    addresses: Array<{ email: string; name?: string }>,
  ): string {
    return addresses
      .map((address) =>
        address.name ? `${address.name} <${address.email}>` : address.email,
      )
      .join(", ");
  }

  private parseDateHeader(value?: string): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}
