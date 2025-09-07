// src/app/api/google/calendar/list/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionId } from "@/lib/session";           // reads signed 'sid' from cookies()
import { PrismaClient } from "@prisma/client";
import { googleCalendarService } from "@/services/googleCalendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // avoid static optimization/caching

// Reuse a single Prisma instance (important in dev/hot reload)
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

// Helper: parse ISO/RFC3339-ish strings safely
function parseDateOrUndefined(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireUserId();

    const sp = req.nextUrl.searchParams;
    const timeMin = parseDateOrUndefined(sp.get("timeMin"));
    const timeMax = parseDateOrUndefined(sp.get("timeMax"));
    const maxResults = sp.get("maxResults") ? Number(sp.get("maxResults")) : undefined;

    // Sensible defaults: 7-day window if none provided
    let tMin = timeMin;
    let tMax = timeMax;
    if (!tMin && !tMax) {
      tMin = new Date();
      tMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } else if (tMin && !tMax) {
      tMax = new Date(tMin.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (!tMin && tMax) {
      // backfill 7 days before tMax
      tMin = new Date(tMax.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    if (!tMin || !tMax) {
      return NextResponse.json(
        { ok: false, message: "Invalid timeMin/timeMax." },
        { status: 400 }
      );
    }

    // Optional guard: avoid accidentally huge ranges (> 366 days)
    if ((tMax.getTime() - tMin.getTime()) / (1000 * 60 * 60 * 24) > 366) {
      return NextResponse.json(
        { ok: false, message: "Date range too large. Use ≤ 366 days." },
        { status: 400 }
      );
    }

    // Pass through options if your service supports them
    const events = await googleCalendarService.getEvents(userId, tMin, tMax, {
      maxResults,          // optional
      singleEvents: true,  // ensure expansions; your service can ignore if not used
      orderBy: "startTime" // keep results ordered
    });

    return NextResponse.json({ ok: true, events }, { status: 200 });
  } catch (err: any) {
    const msg = err?.message ?? "Failed to list calendar events";
    const status = /not authenticated|not connected/i.test(msg) ? 401 : 500;
    return NextResponse.json({ ok: false, message: msg }, { status });
  }
}
