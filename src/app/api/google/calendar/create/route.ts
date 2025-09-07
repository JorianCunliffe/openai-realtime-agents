// src/app/api/google/calendar/create/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionId } from "@/lib/session";           // reads signed 'sid' from cookies()
import { PrismaClient } from "@prisma/client";
import { googleCalendarService } from "@/services/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reuse a single Prisma instance (important for dev/hot reload)
const prisma = (globalThis as any).__PRISMA__ ?? new PrismaClient();
if (!(globalThis as any).__PRISMA__) (globalThis as any).__PRISMA__ = prisma;

async function requireUserId(): Promise<string> {
  const sid = await getSessionId();
  if (!sid) throw new Error("Not authenticated");
  const s = await prisma.session.findUnique({
    where: { id: sid },
    select: { userId: true },
  });
  if (!s?.userId) throw new Error("Not authenticated");
  return s.userId;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();

    const body = await req.json();
    const {
      summary,
      description,
      startDateTime,
      endDateTime,
      attendees,
      location,
      timeZone,
    } = body || {};

    if (!summary || !startDateTime || !endDateTime) {
      return NextResponse.json(
        { ok: false, message: "summary, startDateTime and endDateTime are required" },
        { status: 400 }
      );
    }

    const event = await googleCalendarService.createEvent(userId, {
      summary,
      description,
      startDateTime, // ISO 8601 w/ offset, e.g. "2025-09-06T10:30:00+10:00"
      endDateTime,
      attendees,     // e.g. ["person@example.com"]
      location,
      timeZone: timeZone || "Australia/Brisbane",
    });

    return NextResponse.json({ ok: true, event }, { status: 201 });
  } catch (err: any) {
    const msg = err?.message ?? "Failed to create calendar event";
    const status = /not authenticated|not connected/i.test(msg) ? 401 : 500;
    return NextResponse.json({ ok: false, message: msg }, { status });
  }
}
