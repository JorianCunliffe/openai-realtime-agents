// src/services/googleCalendar.ts (drop-in)
// Strongly-typed Google Calendar service with free/busy.
// - Keeps your public API shape intact
// - Uses OAuth2Client typing instead of `any`
// - Defaults tz to Australia/Brisbane
// - Adds optional getFreeBusyByUser helper (non-breaking)

import { google, calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getAuthorizedGoogleClient } from "@/lib/auth/google"; // ensure this returns OAuth2Client

// ---- Types ----
export type CreateEventArgs = {
  summary: string;
  description?: string;
  startDateTime: string; // ISO 8601, e.g. "2025-09-06T10:30:00+10:00"
  endDateTime: string;   // ISO 8601
  attendees?: string[];  // ["person@example.com"]
  location?: string;
  timeZone?: string;     // default applied below
};

export type ListOptions = {
  maxResults?: number;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
};

type FreeBusyParams = { timeMin: string; timeMax: string; timeZone?: string };
type FreeBusyResult = { busy: { start: string; end: string }[]; errors?: any[] };

// ---- Internal helper ----
async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
  // Returns an authorized OAuth2 client for this user (tokens already stored)
  const auth = (await getAuthorizedGoogleClient(userId)) as OAuth2Client | null | undefined;
  if (!auth) {
    // Your route handlers key off "not connected" → 401/400 nicely
    throw new Error("Google Calendar not connected");
  }
  return google.calendar({ version: "v3", auth });
}

function ensureIsoString(label: string, value: string) {
  // Very lightweight check to catch obviously malformed inputs.
  // We still pass through to Google for final validation.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} must be an ISO-8601 datetime string`);
  }
}

function dedupeAttendees(emails?: string[]) {
  if (!emails?.length) return [];
  const seen = new Set<string>();
  const result: { email: string }[] = [];
  for (const e of emails) {
    const email = String(e || "").trim();
    if (!email) continue;
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    result.push({ email });
  }
  return result;
}

// ---- Public API ----
export const googleCalendarService = {
  async createEvent(userId: string, args: CreateEventArgs) {
    const cal = await getCalendarClient(userId);
    const tz = args.timeZone || "Australia/Brisbane";

    ensureIsoString("startDateTime", args.startDateTime);
    ensureIsoString("endDateTime", args.endDateTime);

    // Basic sanity: end after start (best-effort)
    try {
      const start = new Date(args.startDateTime).getTime();
      const end = new Date(args.endDateTime).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("endDateTime must be after startDateTime");
      }
    } catch {
      throw new Error("Invalid date range for event");
    }

    const res = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: { dateTime: args.startDateTime, timeZone: tz },
        end:   { dateTime: args.endDateTime,   timeZone: tz },
        attendees: dedupeAttendees(args.attendees),
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

    return (res.data.items ?? []) as calendar_v3.Schema$Event[];
  },
};

/**
 * Free/busy by authorized client (keeps your original exported name/signature).
 * Prefer this in routes after resolving auth from sid/userId.
 */
export async function getFreeBusy(
  auth: OAuth2Client,
  params: FreeBusyParams
): Promise<FreeBusyResult> {
  if (!params?.timeMin || !params?.timeMax) {
    throw new Error("timeMin and timeMax are required");
  }

  const cal = google.calendar({ version: "v3", auth });
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      timeZone: params.timeZone,
      items: [{ id: "primary" }],
    },
  });

  const fb = res.data.calendars?.primary as { busy?: { start: string; end: string }[]; errors?: any[] } | undefined;
  return {
    busy: fb?.busy ?? [],
    errors: fb?.errors ?? [],
  };
}

/**
 * Optional convenience helper: free/busy by userId.
 * Non-breaking addition; routes may call this directly if preferred.
 */
export async function getFreeBusyByUser(
  userId: string,
  params: FreeBusyParams
): Promise<FreeBusyResult> {
  const auth = (await getAuthorizedGoogleClient(userId)) as OAuth2Client | null | undefined;
  if (!auth) throw new Error("Google Calendar not connected");
  return getFreeBusy(auth, params);
}
