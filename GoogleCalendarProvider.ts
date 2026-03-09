import Agent from "@tokenring-ai/agent/Agent";
import type {AgentCreationContext} from "@tokenring-ai/agent/types";
import type {
  CalendarEvent,
  CalendarEventFilterOptions,
  CalendarEventSearchOptions,
  CalendarProvider,
  CreateCalendarEventData,
  UpdateCalendarEventData,
} from "@tokenring-ai/calendar";
import {z} from "zod";
import GoogleService from "./GoogleService.ts";
import {GoogleCalendarProviderOptionsSchema} from "./schema.ts";
import {GoogleCalendarState} from "./state/GoogleCalendarState.ts";

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

  attach(agent: Agent, _creationContext: AgentCreationContext): void {
    agent.initializeState(GoogleCalendarState, {});
  }

  async getUpcomingEvents(filter: CalendarEventFilterOptions, _agent: Agent): Promise<CalendarEvent[]> {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(filter.calendarId ?? this.calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(filter.limit ?? 10));
    url.searchParams.set("timeMin", (filter.from ?? new Date()).toISOString());
    if (filter.to) url.searchParams.set("timeMax", filter.to.toISOString());

    const response = await this.googleService.fetchGoogleJson<GoogleCalendarListResponse>(
      this.account,
      url.toString(),
      {method: "GET"},
      "list Google Calendar events",
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async searchEvents(filter: CalendarEventSearchOptions, _agent: Agent): Promise<CalendarEvent[]> {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(filter.calendarId ?? this.calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(filter.limit ?? 10));
    url.searchParams.set("q", filter.query);
    url.searchParams.set("timeMin", (filter.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 30)).toISOString());
    if (filter.to) url.searchParams.set("timeMax", filter.to.toISOString());

    const response = await this.googleService.fetchGoogleJson<GoogleCalendarListResponse>(
      this.account,
      url.toString(),
      {method: "GET"},
      "search Google Calendar events",
    );

    return (response.items ?? []).map(item => this.toCalendarEvent(item));
  }

  async createEvent(data: CreateCalendarEventData, agent: Agent): Promise<CalendarEvent> {
    const response = await this.googleService.fetchGoogleJson<GoogleCalendarEventResponse>(
      this.account,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(data.calendarId ?? this.calendarId)}/events`,
      {
        method: "POST",
        body: JSON.stringify(this.toGoogleEventBody(data)),
      },
      "create Google Calendar event",
    );

    const event = this.toCalendarEvent(response);
    agent.mutateState(GoogleCalendarState, state => {
      state.currentEvent = event;
    });
    return event;
  }

  async updateEvent(data: UpdateCalendarEventData, agent: Agent): Promise<CalendarEvent> {
    const currentEvent = this.getCurrentEvent(agent);
    if (!currentEvent) throw new Error("No calendar event is currently selected. Select or create an event first.");

    const mergedEvent: UpdateCalendarEventData = {
      calendarId: data.calendarId ?? currentEvent.calendarId,
      title: data.title ?? currentEvent.title,
      description: data.description ?? currentEvent.description,
      location: data.location ?? currentEvent.location,
      startAt: data.startAt ?? currentEvent.startAt,
      endAt: data.endAt ?? currentEvent.endAt,
      allDay: data.allDay ?? currentEvent.allDay,
      attendees: data.attendees ?? currentEvent.attendees,
      status: data.status ?? currentEvent.status,
      url: data.url ?? currentEvent.url,
      meetingUrl: data.meetingUrl ?? currentEvent.meetingUrl,
    };

    const response = await this.googleService.fetchGoogleJson<GoogleCalendarEventResponse>(
      this.account,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(mergedEvent.calendarId ?? this.calendarId)}/events/${encodeURIComponent(currentEvent.id)}`,
      {
        method: "PUT",
        body: JSON.stringify(this.toGoogleEventBody(mergedEvent)),
      },
      "update Google Calendar event",
    );

    const event = this.toCalendarEvent(response);
    agent.mutateState(GoogleCalendarState, state => {
      state.currentEvent = event;
    });
    return event;
  }

  async selectEventById(id: string, agent: Agent): Promise<CalendarEvent> {
    const response = await this.googleService.fetchGoogleJson<GoogleCalendarEventResponse>(
      this.account,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`,
      {method: "GET"},
      `fetch Google Calendar event ${id}`,
    );

    const event = this.toCalendarEvent(response);
    agent.mutateState(GoogleCalendarState, state => {
      state.currentEvent = event;
    });
    return event;
  }

  getCurrentEvent(agent: Agent): CalendarEvent | null {
    return agent.getState(GoogleCalendarState).currentEvent;
  }

  async clearCurrentEvent(agent: Agent): Promise<void> {
    agent.mutateState(GoogleCalendarState, state => {
      state.currentEvent = null;
    });
  }

  async deleteCurrentEvent(agent: Agent): Promise<void> {
    const currentEvent = this.getCurrentEvent(agent);
    if (!currentEvent) throw new Error("No calendar event is currently selected.");

    await this.googleService.fetchGoogleRaw(
      this.account,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(currentEvent.calendarId ?? this.calendarId)}/events/${encodeURIComponent(currentEvent.id)}`,
      {method: "DELETE"},
      "delete Google Calendar event",
    );

    agent.mutateState(GoogleCalendarState, state => {
      state.currentEvent = null;
    });
  }

  private toCalendarEvent(item: GoogleCalendarEventResponse): CalendarEvent {
    return {
      id: item.id,
      calendarId: this.calendarId,
      title: item.summary ?? "(untitled event)",
      description: item.description,
      location: item.location,
      startAt: this.parseGoogleDate(item.start),
      endAt: this.parseGoogleDate(item.end),
      allDay: !!item.start?.date && !item.start?.dateTime,
      attendees: item.attendees?.filter(attendee => attendee.email).map(attendee => ({
        email: attendee.email!,
        name: attendee.displayName,
        responseStatus: attendee.responseStatus,
      })),
      status: item.status,
      url: item.htmlLink,
      meetingUrl: item.hangoutLink,
      createdAt: item.created ? new Date(item.created) : undefined,
      updatedAt: item.updated ? new Date(item.updated) : undefined,
    };
  }

  private toGoogleEventBody(data: Partial<CreateCalendarEventData | UpdateCalendarEventData>) {
    return {
      summary: data.title,
      description: data.description,
      location: data.location,
      status: data.status,
      start: this.toGoogleDateTime(data.startAt, data.allDay),
      end: this.toGoogleDateTime(data.endAt, data.allDay),
      attendees: data.attendees?.map(attendee => ({
        email: attendee.email,
        displayName: attendee.name,
        responseStatus: attendee.responseStatus,
      })),
    };
  }

  private toGoogleDateTime(date: Date | undefined, allDay?: boolean) {
    if (!date) return undefined;
    if (allDay) {
      return {date: date.toISOString().slice(0, 10)};
    }
    return {dateTime: date.toISOString()};
  }

  private parseGoogleDate(value?: GoogleCalendarEventDateTime): Date {
    if (value?.dateTime) return new Date(value.dateTime);
    if (value?.date) return new Date(`${value.date}T00:00:00.000Z`);
    return new Date();
  }
}
