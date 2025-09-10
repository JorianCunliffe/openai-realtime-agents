// src/app/api/google/calendar/freebusy/route.ts (Next.js App Router)
import { NextRequest, NextResponse } from "next/server";
import { getAuthorizedClient } from "@/lib/auth/google"; // your helper
import { getFreeBusy } from "@/services/googleCalendar";

export async function POST(req: NextRequest) {
  try {
    const sid = req.headers.get("x-sid") || "";
    const userId = req.headers.get("x-user-id") || undefined;

    // resolve user either from sid or userId (server)
    const auth = await getAuthorizedClient({ sid, userId });
    if (!auth) {
      return NextResponse.json({ ok: false, message: "Google not connected" }, { status: 401 });
    }

    const { timeMin, timeMax, timeZone } = await req.json();
    if (!timeMin || !timeMax) {
      return NextResponse.json({ ok: false, message: "timeMin and timeMax required" }, { status: 400 });
    }

    const data = await getFreeBusy(auth, { timeMin, timeMax, timeZone });
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err?.message || "Freebusy failed" }, { status: 500 });
  }
}
