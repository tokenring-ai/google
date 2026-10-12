import type {
  CalendarEventFilterOptions,
  CalendarEventSearchOptions,
  CalendarProvider,
  CreateCalendarEventData,
  UpdateCalendarEventData,
} from "@tokenring-ai/calendar";
import { type ParsedCalendarEvent, resolveSendUpdates } from "@tokenring-ai/calendar/CalendarProvider";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import type { calendar_v3 } from "googleapis";
import type { z } from "zod";
import type GoogleService from "./GoogleService.ts";
import type { GoogleCalendarProviderOptionsSchema } from "./schema.ts";

type GoogleCalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarEventResponse = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  htmlLink?: string;
  hangoutLink?: string;
  created?: string;
  updated?: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  }>;
};

type GoogleCalendarListResponse = {
  items?: GoogleCalendarEventResponse[];
  nextPageToken?: string;
};

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export default class GoogleCalendarProvider implements CalendarProvider {
  description: string;
  private readonly account: string;
  private readonly calendarId: string;

  constructor(
    private readonly options: z.output<typeof GoogleCalendarProviderOptionsSchema>,
    private readonly googleService: GoogleService,
  ) {
    this.description = options.description;
    this.account = options.account;
    this.calendarId = options.calendarId;
  }

  async getUpcomingEvents(filter: CalendarEventFilterOptions): Promise<ParsedCalendarEvent[]> {
    const response = await this.googleService.withCalendar<GoogleCalendarListResponse>(
      this.account,
      {
        context: "list Google Calendar events",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        // A single page silently truncates dense windows; page until the
        // caller's limit is reached (or the feed is exhausted).
        const limit = filter.limit ?? 10;
        const items: GoogleCalendarEventResponse[] = [];
        let pageToken: string | undefined;
        do {
          const { data } = await calendar.events.list(
            stripUndefinedKeys({
              calendarId: this.calendarId,
              maxResults: limit,
              orderBy: "startTime",
              singleEvents: true,
              timeMax: filter.to?.toISOString(),
              timeMin: (filter.from ?? new Date()).toISOString(),
              pageToken,
            }),
          );
          const page = data as GoogleCalendarListResponse;
          items.push(...(page.items ?? []));
          pageToken = page.nextPageToken;
        } while (pageToken && items.length < limit);
        return { items: items.slice(0, limit) } satisfies GoogleCalendarListResponse;
      },
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async searchEvents(filter: CalendarEventSearchOptions): Promise<ParsedCalendarEvent[]> {
    const response = await this.googleService.withCalendar<GoogleCalendarListResponse>(
      this.account,
      {
        context: "search Google Calendar events",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const limit = filter.limit ?? 10;
        const items: GoogleCalendarEventResponse[] = [];
        let pageToken: string | undefined;
        do {
          const { data } = await calendar.events.list(
            stripUndefinedKeys({
              calendarId: this.calendarId,
              maxResults: limit,
              orderBy: "startTime",
              q: filter.query,
              singleEvents: true,
              timeMax: filter.to?.toISOString(),
              timeMin: (filter.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)).toISOString(),
              pageToken,
            }),
          );
          const page = data as GoogleCalendarListResponse;
          items.push(...(page.items ?? []));
          pageToken = page.nextPageToken;
        } while (pageToken && items.length < limit);
        return { items: items.slice(0, limit) } satisfies GoogleCalendarListResponse;
      },
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async createEvent(data: CreateCalendarEventData): Promise<ParsedCalendarEvent> {
    const response = await this.googleService.withCalendar<GoogleCalendarEventResponse>(
      this.account,
      {
        context: "create Google Calendar event",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data: responseData } = await calendar.events.insert({
          calendarId: this.calendarId,
          sendUpdates: resolveSendUpdates(data),
          requestBody: this.toGoogleEventBody(data),
        });
        return responseData as GoogleCalendarEventResponse;
      },
    );

    return this.toCalendarEvent(response);
  }

  async updateEvent(id: string, data: UpdateCalendarEventData): Promise<ParsedCalendarEvent> {
    const response = await this.googleService.withCalendar<GoogleCalendarEventResponse>(
      this.account,
      {
        context: "update Google Calendar event",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        // Patch, not update: update replaces the whole event, so a partial
        // change (status only, attendees only) would wipe the other fields.
        const { data: responseData } = await calendar.events.patch({
          calendarId: this.calendarId,
          eventId: id,
          sendUpdates: resolveSendUpdates(data),
          requestBody: this.toGoogleEventBody(data),
        });
        return responseData as GoogleCalendarEventResponse;
      },
    );

    return this.toCalendarEvent(response);
  }

  async getEventById(id: string): Promise<ParsedCalendarEvent> {
    const response = await this.googleService.withCalendar<GoogleCalendarEventResponse>(
      this.account,
      {
        context: `fetch Google Calendar event ${id}`,
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data } = await calendar.events.get({
          calendarId: this.calendarId,
          eventId: id,
        });
        return data as GoogleCalendarEventResponse;
      },
    );

    return this.toCalendarEvent(response);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.googleService.withCalendar(
      this.account,
      {
        context: "delete Google Calendar event",
        method: "DELETE",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        await calendar.events.delete({
          calendarId: this.calendarId,
          eventId: id,
        });
      },
    );
  }

  private toCalendarEvent(item: GoogleCalendarEventResponse): ParsedCalendarEvent {
    return stripUndefinedKeys({
      id: item.id,
      title: item.summary ?? "(untitled event)",
      description: item.description,
      location: item.location,
      startAt: this.parseGoogleDate(item.start),
      endAt: this.parseGoogleDate(item.end),
      allDay: !!item.start?.date && !item.start.dateTime,
      attendees: item.attendees?.flatMap(attendee =>
        attendee.email
          ? [
              stripUndefinedKeys({
                email: attendee.email,
                name: attendee.displayName,
                responseStatus: attendee.responseStatus,
              }),
            ]
          : [],
      ),
      status: item.status,
      url: item.htmlLink,
      meetingUrl: item.hangoutLink,
      createdAt: item.created ? new Date(item.created) : undefined,
      updatedAt: item.updated ? new Date(item.updated) : undefined,
    });
  }

  private toGoogleEventBody(data: Partial<CreateCalendarEventData | UpdateCalendarEventData>): calendar_v3.Schema$Event {
    return stripUndefinedKeys({
      summary: data.title,
      description: data.description,
      location: data.location,
      status: data.status,
      start: this.toGoogleDateTime(data.startAt, data.allDay),
      end: this.toGoogleDateTime(data.endAt, data.allDay),
      ...(data.attendees && {
        attendees: data.attendees.map(attendee =>
          stripUndefinedKeys({
            email: attendee.email,
            displayName: attendee.name,
            responseStatus: attendee.responseStatus,
          }),
        ),
      }),
    });
  }

  private toGoogleDateTime(date: Date | undefined, allDay?: boolean, timeZone = "UTC"): calendar_v3.Schema$EventDateTime | undefined {
    if (!date) return undefined;
    // The other form is nulled explicitly so a patch that switches between
    // all-day and timed does not leave both `date` and `dateTime` set.
    if (allDay) {
      // All-day events use a calendar date; pin to UTC components to match stored instants.
      return { date: date.toISOString().slice(0, 10), dateTime: null, timeZone };
    }
    // dateTime is emitted as an absolute UTC instant; include timeZone so Calendar displays correctly.
    return { dateTime: date.toISOString(), date: null, timeZone };
  }

  private parseGoogleDate(value?: GoogleCalendarEventDateTime): Date {
    if (value?.dateTime) return new Date(value.dateTime);
    if (value?.date) return new Date(`${value.date}T00:00:00.000Z`);
    return new Date();
  }
}
