import type {
  CalendarEvent,
  CalendarEventFilterOptions,
  CalendarEventSearchOptions,
  CalendarProvider,
  CreateCalendarEventData,
  UpdateCalendarEventData,
} from "@tokenring-ai/calendar";
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

  async getUpcomingEvents(filter: CalendarEventFilterOptions): Promise<CalendarEvent[]> {
    const response = await this.googleService.withCalendar<GoogleCalendarListResponse>(
      this.account,
      {
        context: "list Google Calendar events",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data } = await calendar.events.list(
          stripUndefinedKeys({
            calendarId: this.calendarId,
            maxResults: filter.limit ?? 10,
            orderBy: "startTime",
            singleEvents: true,
            timeMax: filter.to?.toISOString(),
            timeMin: (filter.from ?? new Date()).toISOString(),
          }),
        );
        return data as GoogleCalendarListResponse;
      },
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async searchEvents(filter: CalendarEventSearchOptions): Promise<CalendarEvent[]> {
    const response = await this.googleService.withCalendar<GoogleCalendarListResponse>(
      this.account,
      {
        context: "search Google Calendar events",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data } = await calendar.events.list(
          stripUndefinedKeys({
            calendarId: this.calendarId,
            maxResults: filter.limit ?? 10,
            orderBy: "startTime",
            q: filter.query,
            singleEvents: true,
            timeMax: filter.to?.toISOString(),
            timeMin: (filter.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)).toISOString(),
          }),
        );
        return data as GoogleCalendarListResponse;
      },
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async createEvent(data: CreateCalendarEventData): Promise<CalendarEvent> {
    const response = await this.googleService.withCalendar<GoogleCalendarEventResponse>(
      this.account,
      {
        context: "create Google Calendar event",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data: responseData } = await calendar.events.insert({
          calendarId: this.calendarId,
          requestBody: this.toGoogleEventBody(data),
        });
        return responseData as GoogleCalendarEventResponse;
      },
    );

    return this.toCalendarEvent(response);
  }

  async updateEvent(id: string, data: UpdateCalendarEventData): Promise<CalendarEvent> {
    const response = await this.googleService.withCalendar<GoogleCalendarEventResponse>(
      this.account,
      {
        context: "update Google Calendar event",
        requiredScopes: [GOOGLE_CALENDAR_SCOPE],
      },
      async calendar => {
        const { data: responseData } = await calendar.events.update({
          calendarId: this.calendarId,
          eventId: id,
          requestBody: this.toGoogleEventBody(data),
        });
        return responseData as GoogleCalendarEventResponse;
      },
    );

    return this.toCalendarEvent(response);
  }

  async getEventById(id: string): Promise<CalendarEvent> {
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

  private toCalendarEvent(item: GoogleCalendarEventResponse): CalendarEvent {
    return stripUndefinedKeys({
      id: item.id,
      title: item.summary ?? "(untitled event)",
      description: item.description,
      location: item.location,
      startAt: this.parseGoogleDate(item.start),
      endAt: this.parseGoogleDate(item.end),
      allDay: !!item.start?.date && !item.start?.dateTime,
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
      createdAt: item.created ? Date.parse(item.created) : undefined,
      updatedAt: item.updated ? Date.parse(item.updated) : undefined,
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

  private toGoogleDateTime(date: Date | undefined, allDay?: boolean) {
    if (!date) return undefined;
    if (allDay) {
      return { date: date.toISOString().slice(0, 10) };
    }
    return { dateTime: date.toISOString() };
  }

  private parseGoogleDate(value?: GoogleCalendarEventDateTime): Date {
    if (value?.dateTime) return new Date(value.dateTime);
    if (value?.date) return new Date(`${value.date}T00:00:00.000Z`);
    return new Date();
  }
}
