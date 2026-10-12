import { beforeEach, describe, expect, it, mock } from "bun:test";
import GoogleCalendarProvider from "../GoogleCalendarProvider.ts";

describe("GoogleCalendarProvider", () => {
  let calendarApi: { events: { insert: ReturnType<typeof mock>; patch: ReturnType<typeof mock>; update: ReturnType<typeof mock> } };
  let provider: GoogleCalendarProvider;

  const googleEvent = {
    id: "ev1",
    summary: "Planning",
    status: "tentative",
    start: { dateTime: "2026-10-12T15:00:00.000Z" },
    end: { dateTime: "2026-10-12T16:00:00.000Z" },
    attendees: [{ email: "bob@example.com", displayName: "Bob", responseStatus: "needsAction" }],
  };

  beforeEach(() => {
    calendarApi = { events: { insert: mock(async () => ({ data: googleEvent })), patch: mock(async () => ({ data: googleEvent })), update: mock() } };
    const googleService = {
      withCalendar: mock(
        async (_account: string, _request: unknown, callback: (calendar: typeof calendarApi) => Promise<unknown>) => await callback(calendarApi),
      ),
    };
    provider = new GoogleCalendarProvider({ description: "Work", account: "primary", calendarId: "primary" } as never, googleService as never);
  });

  it("creates events with attendees and a status", async () => {
    const event = await provider.createEvent({
      title: "Planning",
      startAt: new Date("2026-10-12T15:00:00.000Z"),
      endAt: new Date("2026-10-12T16:00:00.000Z"),
      attendees: [{ email: "bob@example.com", name: "Bob" }],
      status: "tentative",
    });

    const insertCall = calendarApi.events.insert.mock.calls[0]![0] as { sendUpdates: string; requestBody: Record<string, unknown> };
    expect(insertCall.sendUpdates).toBe("all");
    expect(insertCall.requestBody).not.toHaveProperty("sendUpdates");
    expect(insertCall.requestBody).toMatchObject({ summary: "Planning", status: "tentative", attendees: [{ email: "bob@example.com", displayName: "Bob" }] });
    expect(event).toMatchObject({ status: "tentative", attendees: [{ email: "bob@example.com", name: "Bob", responseStatus: "needsAction" }] });
  });

  it("does not email when the event has no guests, and passes an explicit sendUpdates through", async () => {
    await provider.createEvent({
      title: "Solo",
      startAt: new Date("2026-10-12T15:00:00.000Z"),
      endAt: new Date("2026-10-12T16:00:00.000Z"),
    });
    expect(calendarApi.events.insert.mock.calls[0]![0]).toMatchObject({ sendUpdates: "none" });

    await provider.createEvent({
      title: "Quiet",
      startAt: new Date("2026-10-12T15:00:00.000Z"),
      endAt: new Date("2026-10-12T16:00:00.000Z"),
      attendees: [{ email: "bob@example.com" }],
      sendUpdates: "none",
    });
    expect(calendarApi.events.insert.mock.calls[1]![0]).toMatchObject({ sendUpdates: "none" });

    await provider.updateEvent("ev1", { attendees: [{ email: "ada@example.com" }] });
    expect(calendarApi.events.patch.mock.calls[0]![0]).toMatchObject({ sendUpdates: "all" });

    await provider.updateEvent("ev1", { attendees: [{ email: "ada@example.com" }], sendUpdates: "externalOnly" });
    const explicit = calendarApi.events.patch.mock.calls[1]![0] as { sendUpdates: string; requestBody: Record<string, unknown> };
    expect(explicit.sendUpdates).toBe("externalOnly");
    expect(explicit.requestBody).not.toHaveProperty("sendUpdates");
  });

  it("patches only the fields given, so a status change keeps the rest of the event", async () => {
    await provider.updateEvent("ev1", { status: "cancelled" });

    expect(calendarApi.events.update).not.toHaveBeenCalled();
    expect(calendarApi.events.patch).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "ev1",
      sendUpdates: "none",
      requestBody: { status: "cancelled" },
    });
  });

  it("clears the other date form when switching between all-day and timed", async () => {
    await provider.updateEvent("ev1", { startAt: new Date("2026-10-12T00:00:00.000Z"), endAt: new Date("2026-10-13T00:00:00.000Z"), allDay: true });
    const body = (calendarApi.events.patch.mock.calls[0]![0] as { requestBody: Record<string, unknown> }).requestBody;
    expect(body.start).toEqual({ date: "2026-10-12", dateTime: null, timeZone: "UTC" });

    await provider.updateEvent("ev1", { startAt: new Date("2026-10-12T15:00:00.000Z"), endAt: new Date("2026-10-12T16:00:00.000Z"), allDay: false });
    const timed = (calendarApi.events.patch.mock.calls[1]![0] as { requestBody: Record<string, unknown> }).requestBody;
    expect(timed.start).toEqual({ dateTime: "2026-10-12T15:00:00.000Z", date: null, timeZone: "UTC" });
  });
});
