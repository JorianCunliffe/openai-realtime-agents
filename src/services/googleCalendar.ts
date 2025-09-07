import { google, calendar_v3 } from "googleapis";
import { getAuthorizedGoogleClient } from "@/lib/auth/google"; // adjust if your auth service lives elsewhere

// ---- Types ----
export type CreateEventArgs = {
  summary: string;
  description?: string;
  startDateTime: string; // ISO 8601 w/ offset, e.g. "2025-09-06T10:30:00+10:00"
  endDateTime: string;
  attendees?: string[];  // ["person@example.com"]
  location?: string;
  timeZone?: string;     // default applied below
};

export type ListOptions = {
  maxResults?: number;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
};

// ---- Internal helper ----
async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
  // Returns an authorized OAuth2 client for this user (tokens already stored)
  const auth = await getAuthorizedGoogleClient(userId);
  if (!auth) {
    // Your route handlers key off "not connected" → 401/400 nicely
    throw new Error("Google Calendar not connected");
  }
  return google.calendar({ version: "v3", auth });
}


// ---- Public API ----
export const googleCalendarService = {
  async createEvent(userId: string, args: CreateEventArgs) {
    const cal = await getCalendarClient(userId);
    const tz = args.timeZone || "Australia/Brisbane";

    const res = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: { dateTime: args.startDateTime, timeZone: tz },
        end:   { dateTime: args.endDateTime,   timeZone: tz },
        attendees: (args.attendees ?? []).map((email) => ({ email })),
      },
    });

    return res.data;
  },

  async getEvents(
    userId: string,
    timeMin?: Date,
    timeMax?: Date,
    options?: ListOptions
  ) {
    const cal = await getCalendarClient(userId);

    const res = await cal.events.list({
      calendarId: "primary",
      timeMin: timeMin?.toISOString(),
      timeMax: timeMax?.toISOString(),
      singleEvents: options?.singleEvents ?? true,
      orderBy: options?.orderBy ?? "startTime",
      maxResults: options?.maxResults,
    });

    return res.data.items ?? [];
  },
};
